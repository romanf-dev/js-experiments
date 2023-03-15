//
// Example project for MCU_keyhole + NodeJS.
//
// It reads temperature data from MPU-6050 sensor connected via I2C interface to 
// STM32 Bluepill board.
// MPU 6050 is connected to I2C1: pin PB6 to SCL, pin PB7 to SDA with pull-up
// 10k resistors. AD0 -> GND on the sensor, thus addr = 0x68.
// Run as: node i2c.js <path to serial device>
// Example: node i2c.js /dev/ttyACM0
//

const { SerialPort } = require('serialport');
const util = require('util'); 

(async function main() {

    if (process.argv.length === 2) {
        console.error('Please specify serial port name!');
        process.exit(1);
    }

    const port = new SerialPort({ path: process.argv[2], baudRate: 9600, });

    const defaultErrorFunc = (err) => { throw new Error(err); }
    const defaultDataRecvFunc = (data) => { 
        throw new Error('Unexpected data recevied'); 
    }

    port.recvBuffer = new Buffer.alloc(500);
    port.recvPosition = 0;
    port.onError = defaultErrorFunc;
    port.onData = defaultDataRecvFunc;

    port.on('error', (err) => { 
        port.onError(err);
        port.onError = defaultErrorFunc;
    });

    port.on('data', (data) => {
        data.copy(port.recvBuffer, port.recvPosition);
        port.recvPosition += data.length;

        if (data[data.length - 1] == 0) {
            port.recvPosition = 0;
            port.onData(port.recvBuffer);
            port.onData = defaultDataRecvFunc;
        }
    });  

    function response(req) {
        return new Promise((resolve, reject) => {         
            port.onData = resolve;
            port.onError = reject;
            port.write(req);
        }).catch((err) => {
            port.close();
            throw new Error('Port error');
        });
    }

    async function write(addr, data) {
        const req = util.format(
            'w %s %s\n', 
            addr.toString(16), 
            (data >>> 0).toString(16)
        );
        await response(req);
    }

    async function read(addr) {
        const req = util.format('r %s\n', addr.toString(16));
        const str = await response(req);
        const num = parseInt(str, 16);

        if (isNaN(num)) {
            throw new Error('Response parser error');
        }
        return num;
    }

    async function bitSet(addr, bits) {
        const value = await read(addr);
        await write(addr, value | bits);
    }

    async function bitClear(addr, bits) {
        const value = await read(addr);
        await write(addr, value & ~bits);        
    }   

    function widthModifier(size) {
        let modifier = '';
        if (size != undefined) {
            const map = { 1: 'b', 2: 'w', 4: 'd' };
            modifier = map[size];
            if (modifier == undefined) {
                throw new Error('Unknown width modifier')
            }
        }
        return modifier;
    }

    //
    // Batch describes a sequence of commands which is loaded to a MCU and
    // then executed sequentially without USB overhead. This is necessary for
    // protocols like I2C which is heavily depends on timings. When timing does
    // not matter then usual approach with synchronous reads/writes is 
    // recommended. Note that maximum size of the batch is limited to by
    // internal buffers of a MCU, so it must be reasonable, no more than 50
    // commands.
    //
    class Batch {
        constructor() {
            this.chain = new Array(50);
            this.index = 0;
            this.resultCommand = undefined;
            this.cache = undefined;
        }

        wait(addr, bit, value, width) {
            const w = widthModifier(width);
            const wait_id = ((value & 1) << 5) | (bit & 0x1f);
            const cmd = util.format(
                'u%s %s %s', 
                w, addr.toString(16), 
                wait_id.toString(16)
            );
            this.chain[this.index++] = cmd;
            return this;
        }

        read(addr, width) {
            const w = widthModifier(width);
            const cmd = util.format('r%s %s', w, addr.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        write(addr, value, width) {
            const w = widthModifier(width);
            const cmd = util.format(
                'w%s %s %s', 
                w, addr.toString(16), 
                value.toString(16)
            );
            this.chain[this.index++] = cmd;
            return this;
        }

        setAsResult() {
            if (this.resultCommand == undefined) {
                this.resultCommand = this.index - 1;
            } else {
                throw new Error('Result is already set');
            }
            return this;
        }

        get() {
            if (this.index == 0) {
                throw new Error('Empty batch');
            }

            const arr = this.chain.slice(0, this.index);
            const str = arr.join('|') + '\n';
            return str;
        }

        async run() {
            if (this.cache == undefined) {
                this.cache = this.get();
            }

            const resp = await response(this.cache);  
            const result = resp.toString().split('|').map((x) => { 
                return parseInt(x, 16) 
            });

            return (this.resultCommand != undefined) ? 
                result[this.resultCommand] : 
                result;
        }         
    }

    class RCC {
        constructor(baseaddr) {
            this.ahbenr = baseaddr + 0x14;
            this.apb2enr = baseaddr + 0x18;
            this.apb1enr = baseaddr + 0x1c;
            this.cfgr = baseaddr + 0x04;
        }
    }
  
    class I2C {
        constructor(baseaddr) {
            this.cr1 = baseaddr + 0x00;
            this.cr2 = baseaddr + 0x04;
            this.oar1 = baseaddr + 0x08;
            this.oar2 = baseaddr + 0x0c;
            this.dr = baseaddr + 0x10;
            this.sr1 = baseaddr + 0x14;
            this.sr2 = baseaddr + 0x18;
            this.ccr = baseaddr + 0x1c;
            this.trise = baseaddr + 0x20;
        }
    }

    function getReadProc(deviceId, reg) {
        const addr = deviceId << 1;
        const batch = new Batch()
            .write(i2c1.cr1, cr1 | 1 << 8)      // Generate START
            .wait(i2c1.sr1, 0, 1)               // Wait for SB bit to be set
            .write(i2c1.dr, addr)               // Send slave address
            .wait(i2c1.sr1, 1, 1)               // Wait for ADDR
            .read(i2c1.sr1)                     // Read SR1
            .read(i2c1.sr2)                     // Read SR2 to clear ACK
            .wait(i2c1.sr1, 7, 1)               // Wait for TxE
            .write(i2c1.dr, reg)                // Send slave register id
            .wait(i2c1.sr1, 7, 1)               // Wait for TxE
            .write(i2c1.cr1, cr1 | 1 << 8)      // Generate RESTART
            .wait(i2c1.sr1, 0, 1)               // Wait for SB
            .write(i2c1.dr, addr | 1)           // Send read command
            .wait(i2c1.sr1, 1, 1)               // Wait for ADDR
            .write(i2c1.cr1, cr1)               // Clear any bits except PE
            .read(i2c1.sr1)                     // Read SR1
            .read(i2c1.sr2)                     // and SR2 to clear status bits
            .write(i2c1.cr1, cr1 | 1 << 9)      // Generate STOP
            .wait(i2c1.sr1, 6, 1)               // Wait for RxNE
            .read(i2c1.dr).setAsResult()        // Read DR (set as batch result)
            .write(i2c1.cr1, cr1 | 1 << 9)      // Generate STOP

            return batch;
    }    

    function getWriteProc(deviceId, reg, val) {
        const batch = new Batch()
            .write(i2c1.cr1, cr1 | 1 << 8)      // Generate START
            .wait(i2c1.sr1, 0, 1)               // Wait for SB
            .write(i2c1.dr, deviceId << 1)      // Send slave address
            .wait(i2c1.sr1, 1, 1)               // Wait for ADDR bit
            .read(i2c1.sr1)                     // Read status registers
            .read(i2c1.sr2)                     // to clear any status bits
            .wait(i2c1.sr1, 7, 1)               // Wait for TxE
            .write(i2c1.dr, reg)                // Send register id
            .wait(i2c1.sr1, 7, 1)               // Wait for TxE
            .write(i2c1.dr, val)                // Send register value
            .wait(i2c1.sr1, 7, 1)               // Wait until sent
            .write(i2c1.cr1, cr1 | 1 << 9)      // Generate STOP

        return batch;
    }

    const i2c1 = new I2C(0x40005400);
    const rcc = new RCC(0x40021000);
    const gpiob = 0x40010c00;

    //
    // Get MCU id. It may respond with #ERROR first time in case when the host 
    // tried to talk to the device using AT commands. This is OK.
    //
    const fw_id = await response('i\n');

    await bitSet(rcc.cfgr, 4 << 8);            // PCLK1 = 36MHz
    await bitSet(rcc.apb1enr, 1 << 21);        // Enable I2C1
    await bitSet(rcc.apb2enr, 1 << 3);         // Enable IOPB

    await bitSet(gpiob, 1 << 24 | 1 << 28 | 3 << 26 | 3 << 30);

    await write(i2c1.cr1, 0);                   // Disable I2C
    await bitSet(i2c1.cr1, 1 << 15);           // Set SWRST
    await bitClear(i2c1.cr1, 1 << 15);         // Clear SWRST
    await write(i2c1.ccr, 178);                 // Th = Tl = 178 * Tpclk = 5us
    await write(i2c1.trise, 36);                // (1000us / Tpclk) + 1 = 36
    await bitSet(i2c1.cr2, 36);                // PCLK1
    await bitSet(i2c1.cr1, 1);                 // Enable I2C, Standard mode
    const cr1 = await read(i2c1.cr1);

    //
    // E000ED00 is an architecturally defined address for CPU identification.
    //
    const cpuid = await read(0xe000ed00);
    console.log('CPUID: ', cpuid.toString(16));

    //
    // Read device ID (whoami register at 0x75). It should be 0x68.
    //
    const id = await getReadProc(0x68, 0x75).run();
    console.log('device id = ', id);

    if (id != 104) {
        console.log('Wrong sensor ID', id);
        process.exit(1);
    }

    //
    // Wakeup device.
    // 
    await getWriteProc(0x68, 0x6b, 0).run();

    //
    // Get batch command to read register 0x41. The register hold higher part
    // of 2-byte temperature data. Since low part holds only 256/340th part of
    // the data (less than 1 degree) it may be ignored since high accuracy is
    // not required.
    //
    const getTemperature = getReadProc(0x68, 0x41);
    
    async function readSensor() {
        const raw = await getTemperature.run();
        const t = ((((raw << 24) >> 24) * 256) / 340) + 36.5;
        console.log('t = ', t.toFixed(2));
        setTimeout(readSensor, 1000);
    }

    readSensor();

})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
