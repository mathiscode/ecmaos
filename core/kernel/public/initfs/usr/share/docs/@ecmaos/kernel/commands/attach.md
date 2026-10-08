# attach

`man @ecmaos/kernel/commands/attach`

## Synopsis

```
attach [OPTIONS] [USER@]HOST[:PORT]/DEVICE [NAME]
attach -l
attach -d NAME
attach -c NAME OPERATION [JSON-ARGUMENT...]
attach -s [USER@]HOST[:PORT] NAME DEVICE
```

## Description

Use a device of another ecmaOS machine, one started with `ecmaos --listen --device ...`, as `/dev/NAME` on this one. NAME
defaults to DEVICE. It logs in with your key like `connect`, asks for your password to unlock it, and leaves the link up in
the background until `attach -d NAME` or until either side ends it. If the device goes away on the other machine (it is
unplugged, or the machine stops), `/dev/NAME` is removed and a program that had it open reads the end of the file.

Only root can attach, and the other machine only hands its devices to root. It decides which devices it offers, and whether
they can be written to; a device is read-only unless it was offered with `:rw`. Reads wait for the device and writes wait
for it to take the bytes, so a slow device slows the program using it. Nothing on the link is encrypted yet, so use it only
over loopback.

## Offering a device of this machine

`attach -s HOST NAME DEVICE` goes the other way: it logs in to HOST and offers it a device of this machine, which HOST makes
`/dev/NAME` for. DEVICE is `loopback`, or `serial:N[,baud=RATE]` for the Nth serial port this browser has been given access
to (`serial request` asks for one). The machine only takes a device from root, and the port is opened at the speed given
when the machine accepts it (9600 by default; changing it means offering the port again). `attach -d NAME` stops offering.
The device ends if the port is unplugged, which removes `/dev/NAME` over there.

Other devices of this machine, by what DEVICE says:

- `midi:in=N`, `midi:out=N` or `midi:in=N,out=M[,sysex]`: the Nth MIDI input and/or output. Reading gives the raw bytes of the
  messages played; writing takes raw MIDI bytes (cut into whole messages before they are sent). `sysex` asks the browser for
  system-exclusive access. Control `ports` lists what the browser has.
- `gamepad:N`: the Nth gamepad (press a button on it first, or the browser does not show it). Reading gives events in the
  layout of Linux's joystick API (`struct js_event`: u32 time in ms, i16 value, u8 type, u8 number, little endian; type 1 is a
  button, 2 an axis, and 0x80 is added for the state at the start). Control `rumble` takes `{"duration":MS,"strong":0-1,"weak":0-1}`.
- `hid:N`: the Nth HID device this browser has been given access to (`hid request`). Each read is one input report (the report
  id, then its data); a write in the same shape is sent as an output report. Controls: `get-feature ID`, `set-feature ID BYTES`
  and `collections`.

All of them are removed over there when the device is unplugged.

## Options

```
  -p, --pair CODE         enrol your key with this one-time pairing code first
  -F, --fingerprint FP    accept the host only if its key has this fingerprint (SHA256:...)
  -y, --accept-new        remember a host seen for the first time
  -l, --list              list the attached devices
  -d, --detach NAME       remove /dev/NAME and close the link
  -c, --control NAME      send an operation to the device; what it knows depends on the device
  -s, --serve             offer DEVICE of this machine to HOST, where it appears as /dev/NAME (see below)
  --help                  display this help and exit
```

## See also

`connect`, `share`, `man @ecmaos/kernel/commands/mount`
