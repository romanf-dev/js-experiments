//
// Example project for MCU_keyhole + NodeJS.
//
// It reads data from MPU-6050 via the I2C1 interface of STM32 Bluepill board.
// I2C bus uses pin PB6 as SCL, pin PB7 as SDA with pull-up 10k resistors.
// MPU-6050 has AD0 -> GND, thus its I2C addr = 0x68.
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
            this.resultCommand = [];
            this.cache = undefined;
        }

        wait(addr, bit, value, width) {
            const wait_id = ((value & 1) << 5) | (bit & 0x1f);
            const cmd = util.format(
                'u%s %s %s', 
                widthModifier(width), 
                addr.toString(16), 
                wait_id.toString(16)
            );
            this.chain[this.index++] = cmd;
            return this;
        }

        read(addr, width) {
            const cmd = util.format(
                'r%s %s', 
                widthModifier(width), 
                addr.toString(16)
            );

            this.chain[this.index++] = cmd;
            return this;
        }

        write(addr, value, width) {
            const cmd = util.format(
                'w%s %s %s', 
                widthModifier(width), 
                addr.toString(16), 
                value.toString(16)
            );

            this.chain[this.index++] = cmd;
            return this;
        }

        setAsResult() {
            this.resultCommand.push(this.index - 1);
            return this;
        }

        get() {
            if (this.index == 0) {
                throw new Error('Empty batch');
            }

            return this.chain.slice(0, this.index).join('|') + '\n';
        }

        async run() {
            if (this.cache == undefined) {
                this.cache = this.get();
            }

            const resp = await response(this.cache);  
            const result = resp.toString().split('|').map((x) => { 
                return parseInt(x, 16) 
            });

            const translated = this.resultCommand.map((x) => {
                return result[x];
            });

            return translated.length == 1 ? translated[0] : translated;
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
        
        async setup(ccr, trise, pclk) {
            await write(i2c1.cr1, 0);
            await bitSet(i2c1.cr1, 1 << 15);
            await bitClear(i2c1.cr1, 1 << 15);
            await write(i2c1.ccr, ccr);
            await write(i2c1.trise, trise);
            await bitSet(i2c1.cr2, pclk);
            await bitSet(i2c1.cr1, 1);
        }

        getReadProc(deviceId, reg) {
            const addr = deviceId << 1;
            const batch = new Batch()
                .write(this.cr1, (1 << 8) | 1)      // Generate START
                .wait(this.sr1, 0, 1)               // Wait for SB bit to be set
                .write(this.dr, addr)               // Send slave address
                .wait(this.sr1, 1, 1)               // Wait for ADDR
                .read(this.sr2)                     // Read SR2 to clear ACK
                .wait(this.sr1, 7, 1)               // Wait for TxE
                .write(this.dr, reg)                // Send slave register id
                .wait(this.sr1, 7, 1)               // Wait for TxE
                .write(this.cr1, (1 << 8) | 1)      // Generate RESTART
                .wait(this.sr1, 0, 1)               // Wait for SB
                .write(this.dr, addr | 1)           // Send read command
                .wait(this.sr1, 1, 1)               // Wait for ADDR
                .write(this.cr1, 1)                 // Clear any bits except PE
                .read(this.sr1)                     // Read SR1
                .read(this.sr2)                     // and SR2 to clear status bits
                .write(this.cr1, (1 << 9) | 1)      // Generate STOP
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()        // Read DR (set as batch result)
                .write(this.cr1, (1 << 9) | 1)      // Generate STOP

            return batch;
        }

        getReadProc6(deviceId, reg) {
            const addr = deviceId << 1;
            const batch = new Batch()
                .write(this.cr1, (1 << 8) | 1)      // Generate START
                .wait(this.sr1, 0, 1)               // Wait for SB bit to be set
                .write(this.dr, addr)               // Send slave address
                .wait(this.sr1, 1, 1)               // Wait for ADDR
                .read(this.sr2)                     // Read SR2 to clear ACK
                .wait(this.sr1, 7, 1)               // Wait for TxE
                .write(this.dr, reg)                // Send slave register id
                .wait(this.sr1, 7, 1)               // Wait for TxE
                .write(this.cr1, (1 << 8) | 1)      // Generate RESTART
                .wait(this.sr1, 0, 1)               // Wait for SB
                .write(this.dr, addr | 1)           // Send read command
                .wait(this.sr1, 1, 1)               // Wait for ADDR
                .read(this.sr1)                     // Read SR1
                .read(this.sr2)                     // and SR2 to clear status bits
                .write(this.cr1, (1 << 10) | 1)     // Set ACK
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()        // Read DR (set as batch result)
                .write(this.cr1, 1)                 // Clear ACK
                .write(this.cr1, (1 << 9) | 1)      // Generate STOP
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()        // Read last byte
                .write(this.cr1, (1 << 9) | 1)      // Generate STOP

            return batch;
        }

        getWriteProc(deviceId, reg, val) {
            const batch = new Batch()
                .write(this.cr1, (1 << 8) | 1)      // Generate START
                .wait(this.sr1, 0, 1)               // Wait for SB
                .write(this.dr, deviceId << 1)      // Send slave address
                .wait(this.sr1, 1, 1)               // Wait for ADDR bit
                .read(this.sr1)                     // Read status registers
                .read(this.sr2)                     // to clear any status bits
                .wait(this.sr1, 7, 1)               // Wait for TxE
                .write(this.dr, reg)                // Send register id
                .wait(this.sr1, 7, 1)               // Wait for TxE
                .write(this.dr, val)                // Send register value
                .wait(this.sr1, 7, 1)               // Wait until sent
                .write(this.cr1, (1 << 9) | 1)      // Generate STOP

            return batch;
        }
    }

    const i2c1 = new I2C(0x40005400);
    const rcc = new RCC(0x40021000);
    const gpiob = 0x40010c00;

    //
    // Get MCU id. It may respond with #ERROR first time in case when the host 
    // tried to talk to the device using AT commands. This is OK.
    //
    const fwId = await response('i\n');

    //
    // E000ED00 is an architecturally defined address for CPU identification.
    //
    const cpuid = await read(0xe000ed00);
    console.log('CPUID: ', cpuid.toString(16));

    //
    // Enable I2C & IOPB, PCLK1 = 36MHz.
    //
    await bitSet(rcc.cfgr, 4 << 8);
    await bitSet(rcc.apb1enr, 1 << 21);
    await bitSet(rcc.apb2enr, 1 << 3);

    //
    // Set PB6/PB7 as Hispeed, open-drain, alternate function.
    //
    await bitSet(gpiob, 1 << 24 | 1 << 28 | 3 << 26 | 3 << 30);

    //
    // trise = (1000us / Tpclk) + 1 = 36
    // CCR = Th = Tl = 178 * Tpclk = 5us
    // PCLK1 = 36
    //
    await i2c1.setup(178, 36, 36);

    //
    // Read device ID (whoami register at 0x75). It should be 0x68.
    //
    const id = await i2c1.getReadProc(0x68, 0x75).run();
    console.log('device id = ', id);

    if (id != 104) {
        console.log('Wrong sensor ID', id);
        process.exit(1);
    }

    //
    // Wakeup MPU-6050 device. PWR_MGMT_1 = 0.
    // 
    await i2c1.getWriteProc(0x68, 0x6b, 0).run();

    //
    // GYRO_XOUT_H = 0x43. Base address of 6-byte transfer.
    //
    const mpu6050 = i2c1.getReadProc6(0x68, 0x43);

    const conv = (lo, hi) => {
        const word = (hi << 8) | lo;
        const abs = (word << 16) >> 16;
        return abs;
    }

    //
    // Get batch command to read register 0x41. The register hold higher part
    // of 2-byte temperature data. Since low part holds only 256/340th part of
    // the data (less than 1 degree) it may be ignored since high accuracy is
    // not required.
    //
    const getTemperature = i2c1.getReadProc(0x68, 0x41);
    
    async function readSensor() {
        setTimeout(readSensor, 1000);
   }

   async function readSensor() {
        const raw = await getTemperature.run();
        const t = ((((raw << 24) >> 24) * 256) / 340) + 36.5;
        console.log('t = ', t.toFixed(2));
        const gyro = await mpu6050.run();
        console.log('gyro = %d %d %d', conv(gyro[1], gyro[0]), conv(gyro[3], gyro[2]), conv(gyro[5], gyro[4]))
        setTimeout(readSensor, 500);
    }

    readSensor();

})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
