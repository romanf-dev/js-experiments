//
// This example uses two nRF24L01 transmitters connected to SPI1/SPI2 on 
// STM32 Bluepill board.
// Receiver: scl -> a5, miso -> a6, mosi -> a7, nss -> b0, ce -> b1
// Transmitter: scl -> b1#, miso -> b14, mosi -> b15, nss -> b10, ce -> b11
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

    class Batch {
        constructor() {
            this.chain = new Array(50);
            this.index = 0;
            this.resultCommand = [];
            this.cache = undefined;
        }

        wait(addr, bit, value, width = '') {
            const wait_id = ((value & 1) << 5) | (bit & 0x1f);
            const cmd = util.format('u%s %s %s', width, addr.toString(16), wait_id.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        read(addr, width = '') {
            const cmd = util.format('r%s %s', width, addr.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        write(addr, value, width = '') {
            const cmd = util.format('w%s %s %s', width, addr.toString(16), value.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        setAsResult() {
            this.resultCommand.push(this.index - 1);
            return this;
        }

        repeat(n, func) {
            for (let i = 0; i < n; ++i) {
                func(this);
            }

            return this;
        }

        async run() {
            if (this.cache == undefined) {
                this.cache = this.chain.slice(0, this.index).join('|') + '\n';
            }

            const resp = await response(this.cache);  
            const result = resp.toString().split('|');
            const translated = this.resultCommand.map((x) => {
                return parseInt(result[x], 16);
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
            await write(this.cr1, (1 << 6) | (br << 3) | (1 << 2) , 'w');
            await write(this.cr2, 1 << 2, 'w');
        }

        readByte(addr) {
            const batch = new Batch()
                .write(this.bsrr, this.nssReset)      // Set NSS to low
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, addr, 'w')            // Write address byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w')                   // Read dummy data
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, 0, 'w')               // Write data byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w').setAsResult()     // Read dummy data
                .write(this.bsrr, this.nssSet)        // Set NSS to high
            return batch;
        }

        writeByte(addr, val) {
            const batch = new Batch()
                .write(this.bsrr, this.nssReset)      // Set NSS to low
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, addr, 'w')            // Write data byte
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.dr, val, 'w')             // Write data byte
                .wait(this.sr, 1, 1, 'w')             // Wait for TXE bit to be set
                .write(this.bsrr, this.nssSet)        // Set NSS to high
                .read(this.sr, 'w')                   // Read dummy data
            return batch;
        }
    }

    async function setPin(pin, state) {
        const gpio_bsrr = 0x40010c00 + 0x10;
        const val = (state == 1) ? (1 << pin) : (1 << (pin + 16));
        await write(gpio_bsrr, val);
    }

    async function setupTranceiver(spi, config) {
        let n = 0;
        while (n != 2) {
            await new Promise(resolve => setTimeout(resolve, 10));
            await spi.writeByte(0x20, 2).run();
            await new Promise(resolve => setTimeout(resolve, 10));
            n = await spi.readByte(0).run();
            console.log('cfg = ', n);
            await spi.setup(4);
        }

        await spi.writeByte(0x20, config).run();
        await spi.writeByte(0x21, 1).run();
        await spi.writeByte(0x23, 1).run();
        await spi.writeByte(0x24, 0x15).run();
        await spi.writeByte(0x26, 1).run();
        await spi.writeByte(0x31, 1).run();
        const stat = await spi.readByte(7).run();
        console.log('status = ', stat);
        await spi.writeByte(0x22, 1).run();
    }

    async function sendData(spi, data) {
        await spi.writeByte(0xa0, data).run();
        await setPin(ce_send, 1);
        await setPin(ce_send, 0);
        console.log('sent = ', data);
    }

    async function pollPipe(spi) {
        let status = await spi.readByte(7).run();
        if ((status & 0x40) != 0) {
            await spi.writeByte(0x27, 0x40).run();
            const data = await spi.readByte(0x61).run();
            console.log('recvd = ', data);
        }
    }

    const spi1 = new SPI(0x40013000, 0x40010c10, 0);
    const spi2 = new SPI(0x40003800, 0x40010c10, 10);
    const rcc = new RCC(0x40021000);
    const gpioa = 0x40010800;
    const gpiob = 0x40010c00;

    //
    // Get MCU id. It may respond with #ERROR first time in case when the host 
    // tried to talk to the device using AT commands. This is OK.
    //
    const fwId = await response('i\n');
    const cpuid = await read(0xe000ed00);
    console.log('CPUID: ', cpuid.toString(16));

    //
    // Enable SPI, GPIOA and AFIO.
    //
    await bitSet(rcc.apb2enr, 0x100d);
    await bitSet(rcc.apb1enr, 0x4000);
    await write(gpioa, 0x94914444);
    await write(gpiob, 0x44444411);
    await write(gpiob + 4, 0x94911144);

    const ce_recv = 1;
    const ce_send = 11;

    await spi1.setup(4);
    await spi2.setup(4);
    await setPin(ce_recv, 0);
    await setPin(ce_send, 0);

    await setupTranceiver(spi1, 0x7b);
    await setPin(ce_recv, 1);
    await setupTranceiver(spi2, 0x7a);

    while (1) {
        await sendData(spi2, Math.floor(Math.random() * 100));
        await pollPipe(spi1);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
