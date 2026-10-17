# wlcomp

`man @ecmaos/coreutils/wlcomp`

## Synopsis

```
wlcomp [&]
```

## Description

wlcomp is the Wayland compositor. It listens on `$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY` (`/run/user/UID/wayland-0` when they are not set) and serves `wl_compositor`, `wl_shm`, `xdg_wm_base` (toplevels), `wl_output`, `wl_seat` (pointer and keyboard, the US layout), `wp_cursor_shape_manager_v1` and `wl_data_device_manager`. Every toplevel a client creates gets a window (made with `fbwin`) and what the client commits is copied into it.

Run it in the background (`wlcomp &`) and start Wayland programs: `wldemo`, `sdlsnake`, `sdlpaint`, `sdlclip`, or anything built with libwayland-client or SDL 3.

What the windows do reaches the client: resizing, closing, maximize, fullscreen and minimize in both directions, the pointer and the keyboard, and the cursor a client asks for (shown as the window's CSS cursor).

The clipboard is shared with the browser. What a program copies (text) is written to the page's clipboard; the page's clipboard text reaches the program that has the keyboard when Control or Meta is pressed in its window, or on a paste into the window. Text or links dragged from the page onto a window are handed to its program as a drop. Dragging between two programs is not supported, and neither are dropped files.

Set `WLCOMP_DEBUG=1` to log requests to standard error.
