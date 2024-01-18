//
// Reads data using UART from GY33 sensor, transforms it into color id and
// then sends this id to clients using websockets protocol.
//
// Sensor request is {0xa5, 0x54, 0xf9}, it reads processed RGB values where
// each value may only be in range 0-255.
// The sensor responds with 8-byte buffer with the following format:
// {0x5a 0x5a 0x45 0x03 red green blue checksum}
// This is a draft version which does not check any checksums.
//
// This script accepts single argument: the serial device file. Usually, it
// is /dev/ttyUSB0, /dev/ttyACM0 or something like this.
//

const { SerialPort } = require('serialport');
const WebSocket = require('ws');

(async function main() {

    if (process.argv.length === 2) {
        console.error('Please specify serial port name!');
        process.exit(1);
    }

    const port = new SerialPort({ path: process.argv[2], baudRate: 9600, });

    const defaultErrorFunc = (err) => { throw new Error(err); }
    const defaultDataRecvFunc = (data) => { 
        console.log('unexpected data received: ', data); 
    }

    port.recvBuffer = new Buffer.alloc(100);
    port.recvPosition = 0;
    port.expectedLength = 0;
    port.onError = defaultErrorFunc;
    port.onData = defaultDataRecvFunc;

    port.on('error', (err) => { 
        port.onError(err);
        port.onError = defaultErrorFunc;
    });

    port.on('data', (data) => {
        data.copy(port.recvBuffer, port.recvPosition);
        port.recvPosition += data.length;

        if (port.recvPosition >= port.expectedLength) {
            const sliceLen = port.expectedLength;
            port.recvPosition = 0;
            port.expectedLength = 0;
            port.onData(port.recvBuffer.slice(0, sliceLen));
            port.onData = defaultDataRecvFunc;
        }
    });  

    function response(req, responseLen) {
        return new Promise((resolve, reject) => {         
            port.onData = resolve;
            port.onError = reject;
            port.expectedLength = responseLen;
            port.write(req);
        }).catch((err) => {
            port.close();
            throw new Error('Port error');
        });
    }

    function RGBtoHSV(r, g, b) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        const s = (max === 0 ? 0 : d / max);
        const v = max / 255;
        var h = 0;

        switch (max) {
            case min: h = 0; break;
            case r: h = (g - b) + d * (g < b ? 6: 0); h /= 6 * d; break;
            case g: h = (b - r) + d * 2; h /= 6 * d; break;
            case b: h = (r - g) + d * 4; h /= 6 * d; break;
        }

        return [h, s, v];
    }

    function HueToColor(h) {
        const range = [
            [117.0, 170.0], // this is used as 'break', its id = -1
            [3.0, 8.0],     // red
            [17.5, 28.5],   // orange
            [45.0, 52.0],   // yellow
            [84.0, 105.0],  // green
            [190.0, 203.0], // light blue
            [204.0, 209.0], // blue
            [215.0, 248.0]  // violet
        ];

        for (var i = 0; i < range.length; ++i) {
            if ((h > range[i][0]) && (h < range[i][1])) {
                return i - 1;
            }
        }

        return null;
    }

    const server = new WebSocket.Server({ port: 8080 });
    let sockets = [];

    server.on('connection', function(socket) {
        sockets.push(socket);

        socket.on('close', function() {
            sockets = sockets.filter(s => s !== socket);
        });
    });

    let color = null;
    const map = ['red', 'orange', 'yellow', 'green', 'light blue', 'blue', 'violet'];
    const request = Buffer.from([0xA5, 0x54, 0xf9]);

    async function readSensor() {
        const data = await response(request, 8);
        const red = data[4];
        const green = data[5];
        const blue = data[6];
        const hsv = RGBtoHSV(red, green, blue);
        const hue = hsv[0].toFixed(2) * 360;
        const new_color = HueToColor(hue);

        if (new_color != null) {
            if (color != new_color) {
                color = new_color;
                if (color >= 0) {
                    console.log('sent: %s', map[color]);
                    sockets.forEach(s => s.send(color));
                }
            }
        }

        setTimeout(readSensor, 200);
    }

    readSensor();

})().catch(err => { 
    console.log('Something goes wrong :(');
    console.log(err);
    process.exit(1);
});
