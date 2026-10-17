# sdlpaint

`man @ecmaos/coreutils/sdlpaint`

## Synopsis

```
sdlpaint [WIDTH [HEIGHT]]
```

## Description

A paint program on SDL 3, through its Wayland driver; it needs `wlcomp` running. The picture is 480x360 unless given and follows the window when it is resized.

The left button draws and the right button erases. The wheel or `[` and `]` change the brush size, a swatch or the keys `1` to `9` pick a color, `C` clears, `F` toggles fullscreen and Escape quits. The pointer is a ring over the picture in the brush color and size (a cursor the program draws) and an arrow over the palette.
