# sdlpad

`man @ecmaos/coreutils/sdlpad`

## Synopsis

```
sdlpad [WIDTH [HEIGHT]]
```

## Description

A window that shows a gamepad, on SDL 3 through its Wayland driver; it needs `wlcomp` running.

A square for each button lights while it is held, and a bar for each axis has a marker that moves with the stick. The pads are the browser's, read from `/dev/js0` to `/dev/js3`; the browser lists a pad only after a button has been pressed on it, and `sdlpad` notices it within a second. A pad with the standard layout also prints the name of each button (`a`, `dpup`, `leftshoulder`) as it goes down or up. Escape quits.

Programs of your own can use the same pads through SDL's joystick and gamepad API. A standard pad has its triggers as buttons, not analog axes, and the driver has no rumble.
