JavaScript micro-projects
=========================

sensor.js
---------

Example of using mcu_keyhole with NodeJS.
It reads data from STM32 Bluepill internal temperature sensor and then creates a webserver  to stream the data via HTTP. 
This demonstrates how various applications may be implemented entirely in JavaScript without MCU FW updates.
Note that sensor shows relative temperature rather than absolute, so it shows how temperature of the MCU core increases since its start.

Run as: 

    node sensor.js <path to serial device>

Example: 

    node sensor.js /dev/ttyACM0


i2c.js
------

Example of temperature sensor reading on MPU-6050 device using NodeJS.

wiki-nightmode.js
-----------------

Official wikipedia app for iPhone/iPad does not support night mode, it is my attempt to fix it.

- Create 'app' using Shortcuts and add 'Run JavaScript on Safari web page' item.
- Insert this code into the item.

Now you can use the shortcut on Wikipedia pages to switch the page to night mode (gray background, white text).

ws_client/server
----------------

Websocket example: client requests data from the server then draws received value on a chart.
No error handling is performed, this is just an example.
