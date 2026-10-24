# evtest

`man @ecmaos/coreutils-copyleft/evtest`

## Synopsis

```
evtest [--grab] [DEVICE]
evtest --query DEVICE TYPE VALUE
```

## Description

`evtest` 1.35, from freedesktop.org. Without a device it lists `/dev/input/event*` with their names and asks which one
to watch. With one, it prints what the device is (its ids, name, the events and codes it reports, and the range of each
axis) and then each event as it comes, until it is interrupted or the device goes away. `--grab` takes the device for
itself; `--query` says whether a key or switch is down, with the exit status.

The devices are the keyboard (`event0`), the pointer (`event1`), each pixel window (`event2` and up) and each gamepad
the browser shows (`event34` and up, once a button has been pressed on it), with the codes Linux gives a gamepad:
`BTN_SOUTH` and the other buttons, the sticks as `ABS_X` / `ABS_Y` and `ABS_RX` / `ABS_RY`, the triggers as `ABS_Z` /
`ABS_RZ`, and the d-pad as `ABS_HAT0X` / `ABS_HAT0Y`. `/dev/input/by-id` has a name for each pad.

## Examples

```
evtest
evtest /dev/input/event34
evtest /dev/input/by-id/usb-Wireless_Controller-event-joystick
```

## License

GPL-2.0-or-later. The license text and the offer of source are in `/usr/share/licenses/@ecmaos/coreutils-copyleft/evtest/`.
