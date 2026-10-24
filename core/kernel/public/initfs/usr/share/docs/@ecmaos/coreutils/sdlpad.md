# sdlpad

`man @ecmaos/coreutils/sdlpad`

## Synopsis

```
sdlpad [WIDTH [HEIGHT]]
```

## Description

A window that shows a gamepad, on SDL 3 through its Wayland driver; it needs `wlcomp` running.

A square for each button lights while it is held, and a bar for each axis has a marker that moves with the stick. The pads are the browser's, which the kernel makes `/dev/input/event<N>` with Linux's gamepad codes, and SDL reads them with its own Linux driver; the browser lists a pad only after a button has been pressed on it, and `sdlpad` notices it within about three seconds (SDL looks at `/dev/input` that often). A pad that SDL can map also prints the name of each button (`a`, `dpup`, `leftshoulder`) as it goes down or up. Escape quits.

Programs of your own can use the same pads through SDL's joystick and gamepad API, as on Linux: the triggers are analog axes, the d-pad a hat, and `SDL_RumbleGamepad` reaches a pad that can vibrate.
