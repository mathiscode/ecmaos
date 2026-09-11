# EcmaOS Devices

## Official Devices

> Full list at [https://www.npmjs.com/org/ecmaos-devices](https://www.npmjs.com/org/ecmaos-devices)

- `@ecmaos-devices/audio`: Audio device for sound playback and recording
- `@ecmaos-devices/battery`: Battery status and monitoring device
- `@ecmaos-devices/bluetooth`: Bluetooth device for wireless connectivity
- `@ecmaos-devices/echo`: A minimal loopback device, mainly useful as a reference driver
- `@ecmaos-devices/gamepad`: Gamepad/controller input device
- `@ecmaos-devices/geo`: Geolocation device for position data
- `@ecmaos-devices/gpu`: GPU device for graphics processing
- `@ecmaos-devices/hid`: Human Interface Device support
- `@ecmaos-devices/midi`: MIDI device for musical instruments
- `@ecmaos-devices/presentation`: Presentation device for display control
- `@ecmaos-devices/sensors`: Device for various sensor inputs
- `@ecmaos-devices/serial`: Serial port communication device
- `@ecmaos-devices/tty`: TTY pseudo-devices for `/dev/ttyN`
- `@ecmaos-devices/usb`: USB device connectivity
- `@ecmaos-devices/webgl`: WebGL graphics device

## Major/Minor Number Allocation

Each device registers with a `(major, minor)` pair, the same shape Linux uses in `/dev` and
`/proc/devices`. Where a device corresponds to a real Linux device class, ecmaOS reuses the
LANANA-registered major for that class — `4` for terminals, `13` for input devices, `8` for
block-ish/bulk devices — so the *kind* of thing at that major matches what a Linux user would
expect. Numbers with no real Linux analog (WebGL, WebGPU, Presentation, Bluetooth as a whole bus)
live under an informal "misc" range starting at major `10`, minor `100`, which is not a LANANA
assignment ecmaOS holds — it is a private convention for numbers Linux itself has no equivalent
for, chosen only to keep them out of the way of the reused majors.

| Major | Minor | Device | Note |
|---|---|---|---|
| 1 | 0 | `webgl` | No Linux analog; ecmaOS-assigned |
| 4 | 0–9 | `tty0`–`tty9` | Real Linux tty major |
| 4 | 64 | `serial` | Real Linux `ttyS*` major |
| 5 | 1 | `echo` | Real Linux `/dev/console` major, reused loosely |
| 8 | 0 | `usb` | Real Linux SCSI-disk-class major, reused loosely for USB |
| 8 | vendorId + productId | `usb-<name>-<vendor>-<product>` | One per enumerated USB device |
| 10 | 0 | `gpu` (non-NVIDIA) | Real Linux misc major |
| 10 | 100 | `battery` | ecmaOS misc range |
| 10 | 101 | `geo` | ecmaOS misc range |
| 10 | 102 | `sensors` | ecmaOS misc range |
| 10 | 156 | `presentation` | ecmaOS misc range |
| 13 | 64 | `hid` | Real Linux input-device major |
| 13 | 64+n | `hid-<name>-<vendor>-<product>` | One per enumerated HID device |
| 13 | 1 | `gamepad` | Real Linux input-device major |
| 14 | 4 | `audio` | Real Linux OSS-audio major |
| 35 | 0 | `midi` | Real Linux MIDI major |
| 195 | 0 | `gpu` (NVIDIA) | Real Linux NVIDIA major |
| 216 | 0 | `bluetooth` | Real Linux Bluetooth-adapter major |

`bluetooth` and `usb`'s base entries carry only `kernelId` in their device data — there is no way
to give the *bus itself* a real minor, so `0` marks "the bus, not a device on it." Do not add a new
device with major/minor `(0, 0)`: major `0` is reserved in Linux for "unassigned" and is never a
real device's number.

## Community Devices

> Submit a PR to add your device!

**None yet, [make one!](./README.md)**
