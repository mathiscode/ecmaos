# EcmaOS Devices

## Official Devices

> Full list at [https://www.npmjs.com/org/ecmaos-devices](https://www.npmjs.com/org/ecmaos-devices)

- `@ecmaos-devices/audio`: Audio device for sound playback and recording: ALSA's `/dev/snd` (the real `aplay`, `arecord` and `amixer` run on it) and the OSS nodes (`/dev/dsp`, `/dev/dsp1`, `/dev/dspin`, `/dev/audio`)
- `@ecmaos-devices/battery`: Battery status and monitoring device
- `@ecmaos-devices/bluetooth`: Bluetooth device for wireless connectivity
- `@ecmaos-devices/camera`: Camera device: `/dev/video<n>` (V4L2 read I/O), and offered to other machines as a stream of JPEG pictures
- `@ecmaos-devices/echo`: A minimal loopback device, mainly useful as a reference driver
- `@ecmaos-devices/gamepad`: Gamepad/controller input device
- `@ecmaos-devices/geo`: Geolocation device for position data
- `@ecmaos-devices/gpu`: GPU device for graphics processing
- `@ecmaos-devices/hid`: Human Interface Device support
- `@ecmaos-devices/midi`: MIDI device for musical instruments
- `@ecmaos-devices/presentation`: Presentation device for display control
- `@ecmaos-devices/sensors`: Device for various sensor inputs
- `@ecmaos-devices/serial`: Serial port communication device
- `@ecmaos-devices/session`: Shared plumbing for drivers built on sessions (not a device)
- `@ecmaos-devices/tty`: No longer registers a device - superseded by `attach_xterm`'s real `/dev/xterm<n>` nodes (see below)
- `@ecmaos-devices/usb`: USB device connectivity
- `@ecmaos-devices/webgl`: WebGL graphics device

## Sessions

A driver that talks to browser hardware (`serial`, `midi`, `gamepad`, `hid`, `usb`, `bluetooth`, `battery`, `geo`, `sensors`,
`audio`, `camera`) has a `session.ts` that opens the hardware as a `DeviceSession` (`@ecmaos-devices/session`): bytes to read,
bytes to write, controls and events. Two things use it. `sessionOperations` makes a `/dev` node from one (`midi<n>`,
`hidraw<n>`, `dsp`, `dsp1`, `dspin`), and `attach -s` serves one to another machine over a device channel. A driver is written
once and works both ways.

## Terminals

A device that is a terminal on Linux (a serial port) is not a session node but a `@zenfs/linux` `TTYDriver`, which a package
returns from `getTTYDrivers(ctx)` next to `getDrivers`. The kernel registers its numbers and tells it the first open and last
close of each line; the package adds a line (`driver.line(n).register()`) when a device appears and hangs it up when the device
goes. The line discipline (canonical mode, echo, signals) is the tty layer's, so the driver only moves bytes, applies `c_cflag`
in `set_termios`, and answers its own ioctls (`TIOCMGET`, `TCSBRK`, ...). `serial` is the one there is: its `session.ts` still
serves `attach -s`, and its `tty.ts` drives the port behind each line.

## Major/Minor Number Allocation

A driver that asks for major 0 gets a dynamic major of its own (one per package), so minors only have to be unique inside a
package.


Devices register through `char_dev.register(major, name, ops)` (`@zenfs/linux`), which claims an
**entire major** - all 256 minors - for one `FileOperations` object. Two packages can no longer
informally share a major the way the old `@zenfs/core` model allowed: a package with more than one
device under the same major (`usb`, `hid`) registers that major once and dispatches to the right
device by minor inside its own `ops`, the same pattern `@zenfs/linux`'s own `drivers/char/mem.js`
uses for `/dev/{null,zero,full,random}`.

Where a device corresponds to a real Linux device class, ecmaOS reuses the LANANA-registered major
for that class, so the *kind* of thing at that major matches what a Linux user would expect.
Numbers with no real Linux analog live under an informal "misc" range starting at major `10`,
minor `100` - a private ecmaOS convention, not a LANANA assignment, chosen to stay out of the way
of the reused majors. Pass `major: 0` to request a dynamically allocated major instead of reusing
or inventing one; prefer this for anything that doesn't need a specific number.

| Major | Minor | Device | Note |
|---|---|---|---|
| 4 | 192–199 | `xterm0`–`xterm7` | Real Linux tty major, via `@zenfs/linux`'s `xterm_driver` (a real `TTYDriver`, not a `char_dev`) - not this org's device packages |
| 5 | 1 | `echo` | Real Linux `/dev/console` major, reused loosely |
| 5 | 2 | `ptmx` | Real Linux pty multiplexer (core, not a package); slaves are `/dev/pts/<n>` on major 136, masters on 128 |
| 10 | 0 | `gpu` (non-NVIDIA) | Real Linux misc major |
| 10 | 100 | `battery` | ecmaOS misc range |
| 10 | 101 | `geo` | ecmaOS misc range |
| 10 | 156 | `presentation` | ecmaOS misc range |
| 10 | 183 | `hwrng` | Real Linux misc minor; `hw_random` in sysfs (core, not a package) |
| 10 | 219 | `log` | ecmaOS misc range; Linux's `/dev/log` is a socket, here a write-only device the kernel files into `/var/log/messages` (core) |
| 10 | 220 | `kmsg` | ecmaOS misc range; Linux has it at 1:11, a major the memory devices hold; writes go to the kernel log (core) |
| 13 | 64 | `input/event0` | Keyboard (core, not a package) |
| 13 | 65 | `input/event1` | Pointer |
| 13 | 0+n | `input/js<n>` | A gamepad's joystick API node (joydev), lowest free number (core, not a package) |
| 13 | 66+n | `input/event<2+n>` | One per framebuffer window, made with its `fb<N>` (`event2`-`event33`) |
| 13 | 98+n | `input/event<34+n>` | One per gamepad the browser shows, lowest free number from `event34`, gone with the pad (core) |
| 14 | 3 | `dsp` | Real Linux OSS-audio major: signed 16-bit mono at 16000 Hz to the speakers |
| 14 | 4 | `audio` | A whole audio file, decoded and played on close |
| 14 | 5 | `dspin` | The microphone, in the format of `dsp` |
| 14 | 19 | `dsp1` | Interleaved 16-bit stereo at 48000 Hz (what SDL programs play to) |
| 29 | 0–31 | `fb<N>` | Real Linux framebuffer major. Made at runtime, one per window (`fbwin`, SDL and Wayland programs); not in the package list |
| 35 | 0 | `midi` | Real Linux MIDI major; the control node |
| 35 | 1+n | `midi<n>` | One per MIDI port, numbered by position |
| 81 | n | `video<n>` | Real Linux video4linux major; one per camera the browser lists, in its order. V4L2 read I/O: `QUERYCAP`, `ENUM_FMT` (`YUYV`, `MJPG`), `G/S/TRY_FMT`, `ENUM_FRAMESIZES`/`FRAMEINTERVALS`, `G/S_PARM`, the one input; a read gives one whole frame. No buffers (`REQBUFS` is `EINVAL`) until device `mmap` exists |
| 0 (dynamic) | 0 | `camera` | The command's control node; a camera is also offered to other machines with `attach -s` |
| 116 | 0 | `snd/controlC0` | Real Linux ALSA major; the card's control node (`amixer`): card info, the PCM devices, the mixer's four controls (Master and Capture, volume and switch) |
| 116 | 16 | `snd/pcmC0D0p` | The speakers as ALSA's PCM playback device: `HW_REFINE`/`HW_PARAMS`/`SW_PARAMS`, `STATUS`, `SYNC_PTR`, `PREPARE`/`START`/`DROP`/`DRAIN`/`PAUSE`, `WRITEI_FRAMES`. Read and write access only (no mmap: alsa-lib falls back to `SYNC_PTR`, and its `mmap_emul` plugin gives a program mapped access); 8/16/24/32-bit integer and 32-bit float samples, 1 to 8 channels, 8000 to 192000 Hz; one user at a time |
| 116 | 24 | `snd/pcmC0D0c` | The microphone as the PCM capture device (`READI_FRAMES`); same ioctls and formats |
| 166 | 0+n | `ttyACM<n>` | Real Linux CDC ACM major; serial ports that are boards (a terminal: `@zenfs/linux` `TTYDriver`) |
| 180 | 0 | `usb` | Real Linux USB major; the control node |
| 180 | 1+n | `usb<n>` | One per granted USB device; the number stays with the device (`/var/lib/ecmaos/usb-minors.json`) |
| 188 | 0+n | `ttyUSB<n>` | Real Linux USB-serial major; serial ports behind a bridge chip (FTDI, CP210x, CH340, PL2303) |
| 195 | 0 | `gpu` (NVIDIA) | Real Linux NVIDIA major |
| 216 | 0+n | `rfcomm<n>` | Real Linux RFCOMM major; Bluetooth serial ports |
| 226 | 0 | `webgl` | Real Linux DRM major, reused loosely |
| 227 | 0–15 | `gl<N>` | One OpenGL ES context each, drawn by WebGL2 (core, not a package); ecmaOS-assigned, clear of `webgl` |
| 227 | 128 | `glctl` | Asks for a GL context before a program has one |
| 0 (dynamic) | 0 | `serial` | WebSerial's control node; the ports are `ttyACM<n>`, `ttyUSB<n>` and `rfcomm<n>` above |
| 0 (dynamic) | 0, 1+n | `bluetooth`, `ble<n>` | One per paired Bluetooth LE device, which has no node on Linux; the number stays with the device |
| 0 (dynamic) | 64, 1+n | `hid`, `hidraw<n>` | WebHID. `hidraw<n>` takes Linux's `HIDIOCGRAWINFO`, `GRAWNAME`, `GRAWPHYS`, `GRDESCSIZE`, `GRDESC` and `GFEATURE`/`SFEATURE`; a read gives one report (with its id in front only if the device numbers its reports), a write one output report. A browser keeps the device's report descriptor, so `GRDESC` gives one written from the parsed collections (the same reports, not the same bytes) |
| 0 (dynamic) | 0 | `gamepad` | The control node; the pads are `input/event<34+n>` and `input/js<n>` above |
| 0 (dynamic) | 0, 1+n | `sensors`, `sensor-<kind>` | One per Generic Sensor class the browser has |
| 0 (dynamic) | 0 | `rtc0` | The real-time clock, dynamic as Linux's rtc class is; `/dev/rtc` links to it (core, not a package) |
| 0 (dynamic) | any | `ecmaos-remote` | Devices attached from another machine (`attach`) |

A control node (`usb`, `bluetooth`, `midi`, `serial`, `hid`, `gamepad`, `sensors`) is the bus, not a device on it, and is
always there, even where the browser lacks the API, so its command can be run. Do not add a new device with major/minor
`(0, 0)` as a fixed number: major `0` asks for a dynamic major, which is fine to request, but is never a real device's
number.

## Community Devices

> Submit a PR to add your device!

**None yet, [make one!](./README.md)**
