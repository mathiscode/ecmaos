# sdlclip

`man @ecmaos/coreutils/sdlclip`

## Synopsis

```
sdlclip [WIDTH [HEIGHT]]
```

## Description

A window that shows the clipboard and what is dropped on it, on SDL 3 through its Wayland driver; it needs `wlcomp` running.

`C` puts a line of text on the clipboard (and so on the page's clipboard), `V` reads the clipboard again, Escape quits. Text copied in the page shows up when Control is pressed in the window or after a paste into it; text or links dragged from the page onto the window are listed. Only letters and digits are drawn.
