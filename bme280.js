
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

    class Batch {
        constructor() {
            this.chain = new Array(50);
            this.index = 0;
            this.resultCommand = [];
            this.cache = undefined;
        }

        wait(addr, bit, value) {
            const wait_id = ((value & 1) << 5) | (bit & 0x1f);
            const cmd = util.format('u %s %s', addr.toString(16), wait_id.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        read(addr) {
            const cmd = util.format('r %s', addr.toString(16));
            this.chain[this.index++] = cmd;
            return this;
        }

        write(addr, value) {
            const cmd = util.format('w %s %s', addr.toString(16), value.toString(16));
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
            this.ahbenr     = baseaddr + 0x14;
            this.apb2enr    = baseaddr + 0x18;
            this.apb1enr    = baseaddr + 0x1c;
            this.cfgr       = baseaddr + 0x04;
        }
    }
  
    class I2C {
        constructor(baseaddr) {
            this.cr1    = baseaddr + 0x00;
            this.cr2    = baseaddr + 0x04;
            this.oar1   = baseaddr + 0x08;
            this.oar2   = baseaddr + 0x0c;
            this.dr     = baseaddr + 0x10;
            this.sr1    = baseaddr + 0x14;
            this.sr2    = baseaddr + 0x18;
            this.ccr    = baseaddr + 0x1c;
            this.trise  = baseaddr + 0x20;
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
    const bme280addr = 0x76;

    const id = await i2c1.readByte(bme280addr, 0xd0).run();
    console.log('device id = ', id);

    if (id != 0x60) {
        console.log('BME280 not found');
        process.exit(1);
    }

    //
    // Temp, humidity, pressure oversampling = x1, normal mode, filter off, Tdelay = 0.5s.
    //
    await i2c1.writeByte(bme280addr, 0xf2, 0x01).run();
    await i2c1.writeByte(bme280addr, 0xf4, 0x27).run();
    await i2c1.writeByte(bme280addr, 0xf5, 0x80).run();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const status = await i2c1.readByte(bme280addr, 0xf3).run();
    console.log('status = ', status);

    async function readShortUnsigned(i2c, addr, reg) {
        const bytes = await i2c.readBytes(addr, reg, 2).run();
        return ((bytes[1] << 8) | bytes[0]);
    }

    function toSignedShort(raw) {
        return (raw & 0x8000) ? raw - 0x10000 : raw;
    }

    async function readShortSigned(i2c, addr, reg) {
        const raw = await readShortUnsigned(i2c, addr, reg);
        return toSignedShort(raw);
    }

    const t1 = await readShortUnsigned(i2c1, bme280addr, 0x88);
    const t2 = await readShortSigned(i2c1, bme280addr, 0x8a);
    const t3 = await readShortSigned(i2c1, bme280addr, 0x8c);
    const p1 = await readShortUnsigned(i2c1, bme280addr, 0x8e);
    const p2 = await readShortSigned(i2c1, bme280addr, 0x90);
    const p3 = await readShortSigned(i2c1, bme280addr, 0x92);
    const p4 = await readShortSigned(i2c1, bme280addr, 0x94);
    const p5 = await readShortSigned(i2c1, bme280addr, 0x96);
    const p6 = await readShortSigned(i2c1, bme280addr, 0x98);
    const p7 = await readShortSigned(i2c1, bme280addr, 0x9a);
    const p8 = await readShortSigned(i2c1, bme280addr, 0x9c);
    const p9 = await readShortSigned(i2c1, bme280addr, 0x9e);
    const h1 = await i2c1.readByte(bme280addr, 0xa1).run();
    const h2 = await readShortSigned(i2c1, bme280addr, 0xe1);
    const h3 = await i2c1.readByte(bme280addr, 0xe3).run();
    const e4_e6 = await i2c1.readBytes(bme280addr, 0xe4, 3).run();
    const h4 = toSignedShort((e4_e6[0] << 4) | (e4_e6[1] & 0x0f));
    const h5 = toSignedShort((e4_e6[2] << 4) | (e4_e6[1] >> 4));
    const h6_unsigned = await i2c1.readByte(bme280addr, 0xe7).run();
    const h6 = (h6_unsigned & 0x80) ? h6_unsigned - 0x100 : h6_unsigned;

    const temp_data = await i2c1.readBytes(bme280addr, 0xfa, 3).run();
    const hum_data = await i2c1.readBytes(bme280addr, 0xfd, 2).run();
    const press_data = await i2c1.readBytes(bme280addr, 0xf7, 3).run();
    const adc_T = ((temp_data[0] << 16) | (temp_data[1] << 8) | (temp_data[2])) >> 4;
    const adc_H = (hum_data[0] << 8) | hum_data[1];
    const adc_p = ((press_data[0] << 16) | (press_data[1] << 8) | (press_data[2])) >> 4;

    const var1 = (adc_T / 16384.0 - t1 / 1024.0) * t2;
    const var2 = ((adc_T / 131072.0 - t1 / 8192.0) ** 2) * t3;
    const t_fine = var1 + var2;
    const t = t_fine / 5120.0;

    console.log('t = ', t);

    let hum = t_fine - 76800.0;
    hum = (adc_H - (h4 * 64.0 + h5 / 16384.0 * hum)) * 
          (h2 / 65536.0 * (1.0 + h6 / 67108864.0 * hum * (1.0 + h3 / 67108864.0 * hum)));
    hum = hum * (1.0 - h1 * hum / 524288.0);

    if (hum > 100.0)
        hum = 100.0;
    else if (hum < 0.0)
        hum = 0.0;

    console.log('h = ', hum);

    let v1 = t_fine / 2.0 - 64000.0;
    let v2 = (v1 * v1 * p6) / 32768.0;
    v2 = v2 + ((v1 * p5) * 2.0);
    v2 = v2 / 4.0 + (p4 * 65536.0);
    v1 = (((v1 * v1 * p3) / 524288.0) + (v1 * p2)) / 524288.0;
    v1 = (1.0 + v1 / 32768.0) * p1;

    if (v1 > 0) {
        let p = 1048576.0 - adc_p;
        p = ((p - v2 / 4096.0) * 6250) / v1;
        v1 = (p9 * p * p) / 2147483648.0;
        v2 = (p8 * p) / 32768.0;
        p = p + (v1 + v2 + p7) / 16.0;
        p = p / 100.0;
        console.log('p = ', p);
    }

    process.exit(0);
})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
