# wldemo

`man @ecmaos/coreutils/wldemo`

## Synopsis

```
wldemo [WIDTH HEIGHT]
```

## Description

wldemo is a small Wayland client written against libwayland-client and libxkbcommon, to look at what `wlcomp` shows and sends: a resizable window with a gradient, a ball that bounces (one frame per frame callback), a square that follows the pointer and turns red while a button is down, and the last key typed, named by libxkbcommon. Escape or closing the window quits.

It needs `wlcomp` running. The size is 320x240 unless given.
