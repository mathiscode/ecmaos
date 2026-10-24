# lsusb

`man @ecmaos/coreutils/lsusb`

## Synopsis

```
lsusb [-i FILE]
```

## Description

Lists the USB devices, from toybox 0.8.12, read from `/sys/bus/usb/devices`: one line each, `Bus 001 Device 002: ID 2341:0043`, with the vendor and product names added when a `usb.ids` file is found (`-i FILE`, or `/etc/usb.ids`, `/usr/share/hwdata/usb.ids`, `/usr/share/misc/usb.ids`; none is installed).

The bus is there, as it is on a Linux machine with no USB, but the browser does not give the kernel a list of what is plugged in: a device is known once the page has been granted it (a serial port, an HID device, a WebUSB device). Nothing is put on this bus yet, so the listing is empty.

## Examples

```
lsusb
```

## See also

`@ecmaos/coreutils/lspci`, `@ecmaos/coreutils/lsblk`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/lsusb/`.
