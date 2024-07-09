JavaScript micro-projects
=========================


adxl345.js
----------

Example of reading from ADXL345 using SPI.


ant.html
--------

Langton's ant implementation.


audio.html
----------

Sound generation using oscillator.


color_client/server.js
----------------------

Using GY33 color sensor to play audio. The sensor should be attached using USB-to-TTL-UART adapter. The server part uses the
sensor for color recognition, it interprets color changes as piano key presses and streams musical note ids via websocket interface.
The client part (should be started after the server) receives note ids and plays audio using pre-generated wav files.
WAV-files are generated using audiosynth.js library.


mpu6050.js
----------

Example of reading from MPU6050 using I2C.


sensor.js
---------

Example of using mcu_keyhole with NodeJS.
It reads data from STM32 Bluepill internal temperature sensor and then creates a webserver  to stream the data via HTTP. 
This demonstrates how various applications may be implemented entirely in JavaScript without MCU FW updates.
Note that sensor shows relative temperature rather than absolute, so it shows how temperature of the MCU core increases since its start.

Run as: 

    node sensor.js <path to serial device>


wiki-nightmode.js
-----------------

Official wikipedia app for iPhone/iPad does not support night mode, it is my attempt to fix it.

- Create 'app' using Shortcuts and add 'Run JavaScript on Safari web page' item.
- Insert this code into the item.

Now you can use the shortcut on Wikipedia pages to switch the page to night mode (gray background, white text).


ws_client/server.js
-------------------

Websocket example: client requests data from the server then draws received value on a chart.
No error handling is performed, this is just an example.

