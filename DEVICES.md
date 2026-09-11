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
- `@ecmaos-devices/tty`: No longer registers a device — superseded by `attach_xterm`'s real `/dev/xterm<n>` nodes (see below)
- `@ecmaos-devices/usb`: USB device connectivity
- `@ecmaos-devices/webgl`: WebGL graphics device

## Major/Minor Number Allocation

Devices register through `char_dev.register(major, name, ops)` (`@zenfs/linux`), which claims an
**entire major** — all 256 minors — for one `FileOperations` object. Two packages can no longer
informally share a major the way the old `@zenfs/core` model allowed: a package with more than one
device under the same major (`usb`, `hid`) registers that major once and dispatches to the right
device by minor inside its own `ops`, the same pattern `@zenfs/linux`'s own `drivers/char/mem.js`
uses for `/dev/{null,zero,full,random}`.

Where a device corresponds to a real Linux device class, ecmaOS reuses the LANANA-registered major
for that class, so the *kind* of thing at that major matches what a Linux user would expect.
Numbers with no real Linux analog live under an informal "misc" range starting at major `10`,
minor `100` — a private ecmaOS convention, not a LANANA assignment, chosen to stay out of the way
of the reused majors. Pass `major: 0` to request a dynamically allocated major instead of reusing
or inventing one; prefer this for anything that doesn't need a specific number.

| Major | Minor | Device | Note |
|---|---|---|---|
| 1 | 0 | `webgl` | No Linux analog; ecmaOS-assigned |
| 4 | 192–199 | `xterm0`–`xterm7` | Real Linux tty major, via `@zenfs/linux`'s `xterm_driver` (a real `TTYDriver`, not a `char_dev`) — not this org's device packages |
| 0 (dynamic) | per port | `serial`, `ttyS<n>` | WebSerial; no longer major 4 — that collided with `xterm_driver` above |
| 5 | 1 | `echo` | Real Linux `/dev/console` major, reused loosely |
| 8 | 0 | `usb` | Real Linux SCSI-disk-class major, reused loosely for USB |
| 8 | 1+n | `usb-<name>-<vendor>-<product>` | One per enumerated USB device, minor by enumeration order (not derived from vendor/product IDs, which can exceed 256 or collide) |
| 10 | 0 | `gpu` (non-NVIDIA) | Real Linux misc major |
| 10 | 100 | `battery` | ecmaOS misc range |
| 10 | 101 | `geo` | ecmaOS misc range |
| 10 | 102 | `sensors` | ecmaOS misc range |
| 10 | 156 | `presentation` | ecmaOS misc range |
| 13 | 64 | `hid` | Real Linux input-device major |
| 13 | 65+n | `hid-<name>-<vendor>-<product>` | One per enumerated HID device, minor by enumeration order |
| 14 | 4 | `audio` | Real Linux OSS-audio major |
| 35 | 0 | `midi` | Real Linux MIDI major |
| 195 | 0 | `gpu` (NVIDIA) | Real Linux NVIDIA major |
| 216 | 0 | `bluetooth` | Real Linux Bluetooth-adapter major |
| 0 (dynamic) | 1 | `gamepad` | No longer major 13 — `hid` needs that major to itself now that majors can't be informally shared |

`bluetooth` and `usb`'s base entries have no per-device data to carry — there is no way to give the
*bus itself* a real minor, so `0` marks "the bus, not a device on it." Do not add a new device with
major/minor `(0, 0)`: major `0` in the *minor* position is reserved in Linux for "unassigned" and is
never a real device's number (major `0` in the *major* position means "allocate dynamically," which
is different and fine to request).

## Community Devices

> Submit a PR to add your device!

**None yet, [make one!](./README.md)**
