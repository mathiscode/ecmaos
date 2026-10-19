# fbwin

`man @ecmaos/kernel/commands/fbwin`

## Synopsis

```
fbwin [-r] [-t TITLE] [WIDTHxHEIGHT]
```

## Description

Opens a window of the given size (640x480 by default) and prints the framebuffer device that draws in it, such as `/dev/fb0`. Writing pixels to the device shows them in the window: 32 bits each, blue first, row after row (`xrgb8888`, 4 bytes per pixel, `WIDTH * 4` bytes per row). `lseek` moves where the next write lands; the `FBIOGET_VSCREENINFO` and `FBIOGET_FSCREENINFO` ioctls describe the screen.

The window and the device go when the command ends or the window is closed.

## Options

- `-r`, `--resizable`: the screen follows the window when the user resizes it, so `/dev/fbN` changes size; `FBIOGET_VSCREENINFO` gives the new size
- `-t`, `--title TITLE`: the window's title
