# microcom

`man @ecmaos/coreutils/microcom`

## Synopsis

```
microcom [-s SPEED] [-X] DEVICE
```

## Description

A serial console, from toybox 0.8.12. It sets `DEVICE` and the terminal raw, shows what the device sends and sends what is typed. `-s` sets the speed (`115200`, `9600`, ...); without it the port keeps the speed it has. `^]` opens a menu: `b` sends a break, `p` sends a file, `q` quits. `-X` turns the menu off.

A serial port the browser has been given (`serial request`) is `/dev/ttyACM<n>` for a board that speaks CDC ACM (an Arduino, a Raspberry Pi Pico, an ESP32 with native USB), `/dev/ttyUSB<n>` for one behind a USB-serial chip (FTDI, CP210x, CH340, PL2303), and `/dev/rfcomm<n>` for a Bluetooth serial port. `/dev/serial/by-id` has a name for each USB port that stays with the device. microcom ends when the device is unplugged.

## Examples

```
serial request
microcom -s 115200 /dev/ttyACM0
microcom -s 9600 /dev/serial/by-id/usb-0403_6001-if00
```

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/microcom/`.
