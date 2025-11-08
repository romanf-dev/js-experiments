//
// Example project for MCU_keyhole + NodeJS.
//
// It reads data from ADXL345 via the SPI1 interface of STM32 Bluepill board.
// SPI bus uses pins PA4-PA7.
// Run as: node adxl345.js <path to serial device>
// Example: node adxl345.js /dev/ttyACM0
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
            const resp = port.recvBuffer.subarray(0, port.recvPosition);
            port.recvPosition = 0;
            port.onData(resp);
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

    async function write(addr, data, width) {
        if (width == undefined) {
            width = '';
        }

        const req = util.format('w%s %s %s\n', width, addr.toString(16), (data >>> 0).toString(16));
        await response(req);
    }

    async function read(addr, width) {
        if (width == undefined) {
            width = '';
        }

        const req = util.format('r%s %s\n', width, addr.toString(16));
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

    //
    // Batch describes a sequence of commands which is loaded to a MCU and
    // then executed sequentially without USB overhead.
    //
    class Batch {
        constructor() {
            this.chain = new Array(50);
            this.index = 0;
            this.resultCommand = [];
            this.cache = undefined;
        }

        wait(addr, bit, value, width) {
            const waitId = ((value & 1) << 5) | (bit & 0x1f);
            const cmd = util.format('u%s %s %s', width, addr.toString(16), waitId.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        read(addr, width) {
            const cmd = util.format('r%s %s', width, addr.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        write(addr, value, width) {
            const cmd = util.format('w%s %s %s', width, addr.toString(16), value.toString(16));
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
            const result = resp.toString().split('|').map((x) => { return parseInt(x, 16) });
            const translated = this.resultCommand.map((x) => { return result[x]; });
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
  
    class SPI {
        constructor(baseaddr, gpio, nss) {
            this.cr1 = baseaddr + 0x00;
            this.cr2 = baseaddr + 0x04;
            this.sr = baseaddr + 0x08;
            this.dr = baseaddr + 0x0c;
            this.bsrr = gpio;
            this.nssReset = 1 << (nss + 16);
            this.nssSet = 1 << nss;
        }
        
        async setup(br) {
            await write(this.bsrr, this.nssSet, 'd');
            await write(this.cr1, 0, 'w');
            await write(this.cr1, (1 << 6) | (br << 3) | (1 << 2) | (1 << 1) | (1 << 0), 'w');
            await write(this.cr2, 1 << 2, 'w');
        }

        getReadByteProc(addr) {
            const id = (1 << 7) | addr;
            const batch = new Batch()
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.bsrr, this.nssReset, 'd') // Set NSS to low
                .write(this.dr, id, 'w')              // Write address byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w')                   // Read dummy data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read dummy data
                .write(this.bsrr, this.nssSet, 'd')   // Set NSS to high
            return batch;
        }

        getReadSixByteProc(addr) {
            const id = (1 << 7) | (1 << 6) | addr;    // Set R and MB bits
            const batch = new Batch()
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.bsrr, this.nssReset, 'd') // Set NSS to low
                .write(this.dr, id, 'w')              // Write address byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w')                   // Read dummy data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read addr[0] data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read addr[1] data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read addr[2] data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read addr[3] data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read addr[4] data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read addr[5] data
                .write(this.bsrr, this.nssSet, 'd')   // Set NSS to high
            return batch;
        }

        getWriteByteProc(addr, val) {
            const batch = new Batch()
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.bsrr, this.nssReset, 'd') // Set NSS to low
                .write(this.dr, addr, 'w')            // Write data byte
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, val, 'w')             // Write data byte
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.bsrr, this.nssSet, 'd')   // Set NSS to high
                .read(this.sr, 'w')                   // Read dummy data
            return batch;
        }
    }

    const spi1 = new SPI(0x40013000, 0x40010810, 4);  // 2nd/3rd params are GPIO[BSRR] and bit used as NSS.
    const rcc = new RCC(0x40021000);
    const gpioa = 0x40010800;

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
    // Enable SPI, GPIOA and AFIO.
    //
    await bitSet(rcc.apb2enr, 0x1005);

    //
    // PA4: push-pull GPIO, PA5/PA7 alternate function push-pull, max speed 10MHz,
    // PA6: floating input.
    //
    await write(gpioa, 0x94914444);

    //
    // Divide PCLK by 32 = 72/32 ~ 2MHz
    //
    await spi1.setup(4);

    //
    // Read device ID (whoami register at 0). It should be 0xE5.
    //
    const id = await spi1.getReadByteProc(0).run();

    console.log('device id = ', id);

    if (id != 0xe5) {
        console.log('Wrong sensor ID');
        process.exit(1);
    }

    //
    // Wakeup device, set bit 3 at 0x2d register.
    //
    await spi1.getWriteByteProc(0x2d, 8).run();

    //
    // Get procedure for 6-byte transfer, but don't run it.
    //
    const adxl345 = spi1.getReadSixByteProc(0x32);

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
