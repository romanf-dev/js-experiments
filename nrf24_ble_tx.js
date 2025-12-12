//
// rx(scl) - a5, rx(miso) - a6, rx(mosi) - a7, rx(nss) - b0, rx(ce) - b1
// tx(scl) - b1*, tx(miso) - b14, tx(mosi) - b15, tx(nss) - b10, tx(ce) - b11
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
        if (width == undefined)
            width = '';
        const req = util.format('w%s %s %s\n', width, addr.toString(16), (data >>> 0).toString(16));
        await response(req);
    }

    async function read(addr, width) {
        if (width == undefined)
            width = '';
        const req = util.format('r%s %s\n', width, addr.toString(16));
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
            for (let i = 0; i < n; ++i)
                func(this);
            return this;
        }

        async run() {
            if (this.cache == undefined) {
                this.cache = this.chain.slice(0, this.index).join('|') + '\n';
                if (this.cache.length >= 2000)
                    throw new Error('Request too long');
            }

            const resp = await response(this.cache);  
            const result = resp.toString().split('|');
            const translated = this.resultCommand.map((x) => parseInt(result[x], 16));
            return translated.length == 1 ? translated[0] : translated;
        }          
    }

    class RCC {
        constructor(baseaddr) {
            this.ahbenr     = baseaddr + 0x14;
            this.apb2enr    = baseaddr + 0x18;
            this.apb1enr    = baseaddr + 0x1c;
            this.cfgr       = baseaddr + 0x04;
        }
    }
  
    class SPI {
        constructor(baseaddr, gpio, nss) {
            this.cr1        = baseaddr + 0x00;
            this.cr2        = baseaddr + 0x04;
            this.sr         = baseaddr + 0x08;
            this.dr         = baseaddr + 0x0c;
            this.bsrr       = gpio;
            this.nssReset   = 1 << (nss + 16);
            this.nssSet     = 1 << nss;
        }
        
        async setup(br) {
            await write(this.bsrr, this.nssSet, 'd');
            await write(this.cr1, 0, 'w');
            await write(this.cr2, 1 << 2, 'w');
            await write(this.cr1, (1 << 6) | (br << 3) | (1 << 2) , 'w');
        }

        readBytes(cmd, n) {
            const batch = new Batch()
                .write(this.bsrr, this.nssReset)      // Set NSS to low
                .write(this.dr, cmd, 'w')             // Write command byte
                .wait(this.sr, 0, 1, 'w')             // Wait for RXNE bit to be set
                .read(this.dr, 'w')                   // Read dummy data
                .repeat(n, (b) => {
                    b.write(this.dr, 0, 'w')          // Write data byte
                    b.wait(this.sr, 0, 1, 'w')        // Wait for RXNE bit to be set
                    b.read(this.dr, 'w').setAsResult()// Read dummy data
                })
                .write(this.bsrr, this.nssSet)        // Set NSS to high
            return batch;
        }

        writeBytes(payload) {
            let counter = 0;
            const batch = new Batch()
                .wait(this.sr, 1, 1, 'w') 
                .write(this.bsrr, this.nssReset)      // Set NSS to low
                .repeat(payload.length, (b) => {
                    b.write(this.dr, payload[counter++], 'w')
                    b.wait(this.sr, 1, 1, 'w')
                })
                .write(this.bsrr, this.nssSet)        // Set NSS to high
                .read(this.sr, 'w')                   // Clear status bits
            return batch;
        }
    }

    function rbit(a){
	    let v = 0;
	    if (a & 0x80) v |= 0x01;
	    if (a & 0x40) v |= 0x02;
	    if (a & 0x20) v |= 0x04;
	    if (a & 0x10) v |= 0x08;
	    if (a & 0x08) v |= 0x10;
	    if (a & 0x04) v |= 0x20;
	    if (a & 0x02) v |= 0x40;
	    if (a & 0x01) v |= 0x80;
	    return v;
    }

    function crc24(data, crc) {
	    for(let bit = 0; bit < 8; bit++) {
            crc <<= 1;
            const x = data >> bit;
            const y = crc >> 24;
		    if ((x ^ y) & 1)
    			crc ^= 0x65b;
            crc &= 0xffffff;
	    }

        return crc;
    }

    function splitBytes(crc) {
        return [ crc & 0xff, (crc >> 8) & 0xff, (crc >> 16 ) & 0xff ];
    }

    function whiten(byte, coeff) {
	    for (let m = 1; m < 0x100; m <<= 1) {
		    if (coeff.c & 0x80) {
			    coeff.c ^= 0x11;
			    byte ^= m;
		    }

		    coeff.c <<= 1;
            coeff.c &= 0xff;
	    }

        return byte;
    }

    //
    // Maximum packet payload is 27 bytes including 6-bytes MAC addr.
    // So actual maximum payload is 27 minus MAC size = 21 minus three
    // bytes flags = 18 bytes for unnamed device.
    //
    class AdvertisementPacket {
        constructor(mac) {
            this.payload = [];
            this.mac = mac;
            this.size = this.mac.length;
        }

        append(type, bytes) {
            const chunk = [bytes.length + 1, type].concat(bytes);
            const data = this.payload.concat(chunk);
            this.payload = data;
            this.size += chunk.length;
            if (this.size > 27) /* 32 - 2 bytes header - 3 bytes CRC. */
                throw new Error('Too large packet');
            return this;
        }

        appendFlags(flags) {
            return this.append(0x01, [flags]);
        }

        appendName(name) {
            const chars = Array.from(name).map((x) => x.charCodeAt(0));
            return this.append(0x09, chars);
        }

        encode(chan) {
            const header = [0x42, this.size];
            const data = header.concat(this.mac).concat(this.payload);
	        const crс = data.reduce((acc, x) => crc24(x, acc), 0x555555);
            const crcBytes = splitBytes(crс).reverse().map((x) => rbit(x));
            let packet = data.concat(crcBytes);
            const coeff = { c: rbit(chan) | 2 };
	        packet.forEach((x, i, self) => self[i] = whiten(x, coeff));
            packet.forEach((x, i, self) => self[i] = rbit(x));
	        return packet;
        }
    }

    async function setPin(pin, state) {
        const gpio_bsrr = 0x40010c00 + 0x10;
        const val = (state == 1) ? (1 << pin) : (1 << (pin + 16));
        await write(gpio_bsrr, val);
    }

    async function setupTranceiver(spi, config) {
        await spi.writeBytes([0x20, 2]).run();
        await new Promise(resolve => setTimeout(resolve, 20));
        const n = await spi.readBytes(0, 1).run();
        console.log('config = ', n);
        await spi.writeBytes([0x20, config]).run();
        await spi.writeBytes([0x21, 0]).run();
        await spi.writeBytes([0x23, 2]).run();
        await spi.writeBytes([0x24, 0]).run();
        await spi.writeBytes([0x25, 2]).run();
        await spi.writeBytes([0x26, 5]).run();
        await spi.writeBytes([0x2a, rbit(0x8E), rbit(0x89), rbit(0xBE), rbit(0xD6)]).run();
        await spi.writeBytes([0x30, rbit(0x8E), rbit(0x89), rbit(0xBE), rbit(0xD6)]).run();
        await spi.writeBytes([0x31, 32]).run();
        const stat = await spi.readBytes(7, 1).run();
        console.log('status = ', stat);
        await spi.writeBytes([0xe1]).run();
        await spi.writeBytes([0xe2]).run();
        await spi.writeBytes([0x22, 1]).run();
    }

    const spi2 = new SPI(0x40003800, 0x40010c10, 10);
    const rcc = new RCC(0x40021000);
    const gpioa = 0x40010800;
    const gpiob = 0x40010c00;
    const ce_send = 11;

    async function sendData(spi, data) {
        const seq = [0xa0].concat(data);
        await spi.writeBytes(seq).run();
        await setPin(ce_send, 1);
        await setPin(ce_send, 0);
    }

    //
    // Get MCU id. It may respond with #ERROR first time in case when the host 
    // tried to talk to the device using AT commands. This is OK.
    //
    const fwId = await response('i\n');
    const cpuid = await read(0xe000ed00);
    console.log('CPUID: ', cpuid.toString(16));

    await bitSet(rcc.apb2enr, 0x000d);
    await bitSet(rcc.apb1enr, 0x4000);
    await write(gpioa, 0x94914444);
    await write(gpiob, 0x44444411);
    await write(gpiob + 4, 0x94911144);

    await spi2.setup(4);
    await setPin(ce_send, 0);
    await setupTranceiver(spi2, 0x72);
	const chan = [2, 26, 80]; // 37, 38, 39
    let index = 0;
    let data = 0;

    while (1) {
        const prototype = new AdvertisementPacket([0xb9, 0xa5, 0x99, 0xa1, 0xb1, 0xb5 | 0xc0]);
        const base = prototype.appendFlags(5).appendName('nRF24L');
        const packet = base.append(0xff, [0xff, 0xff, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, (++data) & 0xff]);
        const bytes = packet.encode(37 + index);
        await sendData(spi2, bytes);
        await new Promise(resolve => setTimeout(resolve, 250));
        index = (index + 1) % chan.length;
        await spi2.writeBytes([0x25, chan[index]]).run();
        await new Promise(resolve => setTimeout(resolve, 250));
        console.log('advertisement ', data);
    }
})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
