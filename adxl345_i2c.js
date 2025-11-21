//
// This example uses ADXL345 sensor connected to I2C1 on STM32 Bluepill board.
// SCL -> PB6, SDA -> PB7, SD0 -> GND, CS -> VCC, pullup resistors are 10k.
// Run as: node adxl345_i2c.js /dev/ttyACM0
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
        if (isNaN(num))
            throw new Error('Response parser error');
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

    class Batch {
        constructor() {
            this.chain = new Array(50);
            this.index = 0;
            this.resultCommand = [];
            this.cache = undefined;
        }

        wait(addr, bit, value, width = '') {
            const wait_id = ((value & 1) << 5) | (bit & 0x1f);
            const cmd = util.format(
                'u%s %s %s', 
                width, 
                addr.toString(16), 
                wait_id.toString(16)
            );
            this.chain[this.index++] = cmd;
            return this;
        }

        read(addr, width = '') {
            const cmd = util.format('r%s %s', width, addr.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        write(addr, value, width = '') {
            const cmd = util.format(
                'w%s %s %s', 
                width, 
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

        repeat(n, func) {
            for (let i = 0; i < n; ++i)
                func(this);
            return this;
        }

        async run() {
            if (this.cache == undefined)
                this.cache = this.chain.slice(0, this.index).join('|') + '\n';

            const resp = await response(this.cache);  
            const result = resp.toString().split('|');
            const translated = this.resultCommand.map((x) => parseInt(result[x], 16));
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

        readByte(deviceId, reg) {
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

        readBytes(deviceId, reg, n) {
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
                .repeat(n - 1, (b) => {
                    b.wait(this.sr1, 6, 1)          // Wait for RxNE
                    b.read(this.dr).setAsResult()
                })
                .write(this.cr1, 1)                 // Clear ACK
                .write(this.cr1, (1 << 9) | 1)      // Generate STOP
                .wait(this.sr1, 6, 1)               // Wait for RxNE
                .read(this.dr).setAsResult()        // Read last byte
                .write(this.cr1, (1 << 9) | 1)      // Generate STOP
            return batch;
        }

        writeByte(deviceId, reg, val) {
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
    const adxl345addr = 0x53;

    //
    // Read device ID (whoami register at 0). It should be 0xe5.
    //
    const id = await i2c1.readByte(adxl345addr, 0).run();
    console.log('device id = ', id);

    if (id != 0xe5) {
        console.log('Wrong sensor ID', id);
        process.exit(1);
    }

    //
    // Wakeup device, set bit 3 at 0x2d register.
    //
    await i2c1.writeByte(adxl345addr, 0x2d, 8).run();

    //
    // Get procedure for 6-byte transfer, but don't run it.
    //
    const adxl345 = i2c1.readBytes(adxl345addr, 0x32, 6);

    const conv = (lo, hi) => {
        const word = (hi << 8) | lo;
        const abs = (word << 16) >> 16;
        return abs;
    }
    
    async function readSensor() {
        const raw = await adxl345.run();
        const x = conv(raw[0], raw[1]);
        const y = conv(raw[2], raw[3]);
        const z = conv(raw[4], raw[5]);
        console.log('acc = %d %d %d', x, y, z);
        setTimeout(readSensor, 500);
    }

    readSensor();
})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
