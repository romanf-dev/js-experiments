//
// Example project for MCU_keyhole + NodeJS.
// It reads data from STM32 Bluepill internal temperature sensor and then creates a webserver 
// to stream the data via HTTP. This demonstrates how various applications may be implemented 
// entirely in JavaScript without MCU FW updates.
// Note that sensor shows relative temperature rather than absolute, so it shows how temperature
// of the MCU core increases since its start.
// 
// Run as: node sensor.js <path to serial device>
// Example: node sensor.js /dev/ttyACM0
//

const { SerialPort } = require('serialport');
const util = require('util'); 
const http = require('http');

(async function main() {

    const host = '0.0.0.0';
    const serv_port = 3000;

    if (process.argv.length === 2) {
        console.error('Please specify serial port name!');
        process.exit(1);
    }

    const port = new SerialPort({ path: process.argv[2], baudRate: 9600, });
    const defaultErrorFunc = (err) => { throw new Error(err); }
    const defaultDataRecvFunc = (data) => {
        console.log('Unexpected data recevied on serial port');
    }

    port.recvBuffer = new Buffer.alloc(100);
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

    class RCC {
      constructor(baseaddr) {
        this.apbenr = baseaddr + 0x14;
        this.apb2enr = baseaddr + 0x18;
        this.cfgr = baseaddr + 0x04;
      }
    }

    class ADC {
      constructor(baseaddr) {
        this.cr1 = baseaddr + 0x04;
        this.cr2 = baseaddr + 0x08;
        this.sr = baseaddr + 0x00;
        this.smpr1 = baseaddr + 0x0c;
        this.smpr2 = baseaddr + 0x10;
        this.sqr1 = baseaddr + 0x2c;
        this.sqr3 = baseaddr + 0x34;
        this.data = baseaddr + 0x4c
      }
    }

    class DMA_Chan {
      constructor(baseaddr) {
        this.ccr = baseaddr + 0x08;
        this.cndtr = baseaddr + 0x0C;
        this.cpar = baseaddr + 0x10;
        this.cmar = baseaddr + 0x14;
      }
    }

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
        const req = util.format('w %s %s\n', addr.toString(16), data.toString(16));
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

    const fwId = await response('i\n');
    console.log(fwId.toString());

    //
    // E000ED00 is an architecturally defined address for CPU identification.
    //
    const cpuid = await read(0xe000ed00);
    console.log('CPUID: ', cpuid.toString(16));

    const rcc = new RCC(0x40021000);
    const adc1 = new ADC(0x40012400);
    const dma1_chan1 = new DMA_Chan(0x40020000);
    const gpioa = 0x40010800;

    //
    // Enable clocks for ADC and GPIO.
    //
    await bitSet(rcc.apb2enr, (1 << 9) | (1 << 2));
    await bitSet(rcc.cfgr, (2 << 14));

    //
    // Configure ADC1 to read data from internal sensor.
    // Refer to the manual for register layout descriptions.
    //
    await write(adc1.cr1, 1 << 8);
    await write(adc1.cr2, 1 << 1);  
    await bitSet(adc1.cr2, (7 << 17));
    await bitClear(adc1.cr2, (1 << 11));
    await bitClear(adc1.smpr2, (7 << 3) | (7 << 12));
    await bitSet(adc1.sqr1, (2 << 20));
    await bitClear(gpioa, (0xf << 4));
    await bitClear(gpioa, (0xf << 16));
    await bitSet(adc1.smpr1, (7 << 18));
    await bitSet(adc1.cr2, (1 << 23));
    await bitSet(adc1.cr2, (1 << 8));
    await bitSet(adc1.sqr3, 1);
    await bitSet(adc1.sqr3, 4 << 5);
    await bitSet(adc1.sqr3, 16 << 10);
    await bitSet(adc1.cr2, 1);

    //
    // Read data from sensor to memory location using DMA.
    // The address is chosen based on memory layout of the MCU.
    //
    await bitSet(rcc.apbenr, 1);
    await bitClear(dma1_chan1.ccr, (1 << 4));
    await bitSet(dma1_chan1.ccr, (1 << 5));
    await bitSet(dma1_chan1.ccr, (1 << 7));
    await bitSet(dma1_chan1.ccr, (1 << 8));
    await bitSet(dma1_chan1.ccr, (1 << 10));   

    await write(dma1_chan1.cndtr, 3);
    await write(dma1_chan1.cpar, adc1.data);
    await write(dma1_chan1.cmar, 0x20004FF0);
    await bitSet(dma1_chan1.ccr, 1);
    
    await write(adc1.sr, 0);
    await bitSet(adc1.cr2, (1 << 20));
    await bitSet(adc1.cr2, (1 << 22));   

    let baseTemp = null;
    let relTemp = null;

    setInterval( async () => {
        const val = await read(0x20004FF4) & 0xffff;    
        const temp = ((1.43 - ((3.3 * val) / 4095)) / 0.0043) + 25;

        if (baseTemp == null)
        {
            baseTemp = temp;
        }

        relTemp = (temp - baseTemp).toFixed(2);
        console.log('temp: ', relTemp);
    }, 1000);

    const server = http.createServer((req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/json');
        const data = { 'temperature': relTemp };
        const json = JSON.stringify(data);
        res.end(json);
        console.log('Http request received');
    });

    server.listen(serv_port, host, () => {
       console.log('Server is running...'); 
    });

})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
