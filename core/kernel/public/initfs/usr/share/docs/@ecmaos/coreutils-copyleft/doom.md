# doom

`man @ecmaos/coreutils-copyleft/doom`

## Synopsis

```
doom -iwad FILE [engine options]
```

## Description

id Software's Doom, run by the doomgeneric engine (GPL-2.0) in a window on SDL 3; it needs `wlcomp` running. The engine draws in software at 640x400 and the window scales it, so it can be resized.

No game data is included. Give it a WAD with `-iwad`: [Freedoom](https://freedoom.github.io/) (`freedoom1.wad`, BSD licensed) works, as does the shareware `doom1.wad` or your own copy of Doom or Doom II. Saved games and settings are written to the current directory.

Keys are Doom's own: the arrows move and turn, Ctrl fires, Space opens doors and switches, Alt strafes, Shift runs, Enter and Escape work the menu (`F1` to `F11` are the usual Doom function keys), and `1` to `7` pick weapons. Closing the window quits. Sound effects play through `/dev/dsp1`; there is no music yet (`-nosound` turns the effects off).
