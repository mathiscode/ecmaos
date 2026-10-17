# sdlsnake

`man @ecmaos/coreutils/sdlsnake`

## Synopsis

```
sdlsnake [WIDTH [HEIGHT]]
```

## Description

Snake on SDL 3, through its Wayland driver; it needs `wlcomp` running. The window can be resized.

Arrow keys or WASD steer, `P` or Space pauses, `R` restarts, `M` mutes the sound and Escape (or closing the window) quits. The snake beeps when it eats and plays a falling tone when it dies; the sound goes to `/dev/dsp1`.
