//
// Websocket example: server responds with random number on any client's request.
//

const WebSocket = require('ws');
const server = new WebSocket.Server({ port: 8080 });

let sockets = [];

server.on('connection', function(socket) {
    sockets.push(socket);

    socket.on('message', function(msg) {
        const val = Math.floor(Math.random() * 10);     // Send random integers...

        console.log('recevied query: ', msg.toString());
        console.log('sent value: ', val.toString());

        sockets.forEach(s => s.send(val.toString()));
    });

    socket.on('close', function() {
        sockets = sockets.filter(s => s !== socket);
    });
});

