# lsusb

`man @ecmaos/coreutils/lsusb`

## Synopsis

```
lsusb [-i FILE]
```

## Description

Lists the USB devices, from toybox 0.8.12, read from `/sys/bus/usb/devices`: one line each, `Bus 001 Device 002: ID 2341:0043`, with the vendor and product names added when a `usb.ids` file is found (`-i FILE`, or `/etc/usb.ids`, `/usr/share/hwdata/usb.ids`, `/usr/share/misc/usb.ids`; none is installed).

The browser does not give the kernel a list of what is plugged in: a device is on the bus once the page has been granted it, as a serial port (`serial request`), an HID device (`hid request`) or a WebUSB device, and it leaves when it is unplugged or forgotten. A board that is both a serial port and an HID device is one line. Devices are numbered from 001 on bus 001 in the order they came, and there is no root hub line, since there is no hub. A WebUSB device has its manufacturer, product name and serial number in `/sys/bus/usb/devices/1-<n>/`; the other two know only the ids (and HID the name). Everything else the browser has not been granted is not listed. Bluetooth HID devices are listed too, as WebHID does not say which they are.

## Examples

```
lsusb
```

## See also

`@ecmaos/coreutils/lspci`, `@ecmaos/coreutils/lsblk`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/lsusb/`.
