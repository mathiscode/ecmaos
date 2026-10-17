# wmctrl

`man @ecmaos/kernel/commands/wmctrl`

## Synopsis

```
wmctrl [-l]
wmctrl ACTION ID [ARGUMENT...]
```

## Description

Lists the windows on the desktop and acts on them. You see and control the windows of your own user (a terminal window belongs to the user it was opened for); root sees every window.

## Actions

- `-l`, `list`: list windows as id, workspace, state, owner pid and title
- `-a`, `focus ID`: raise and focus a window
- `-c`, `close ID`: close a window
- `minimize ID`, `maximize ID`, `restore ID`, `fullscreen ID`: change a window's state
- `move ID X Y`, `resize ID WIDTH HEIGHT`: change a window's geometry
- `title ID TEXT...`: set a window's title

## Workspaces

A machine starts with one workspace (the desktop makes four). A window belongs to one; only the windows of the current workspace are drawn, and focusing a window on another workspace switches to it. A new window opens on the current workspace. Remote screens and host windows show every window.

- `-d`, `desktops`: list the workspaces; the current one is marked `*`
- `-s`, `switch N`: show workspace N (0 is the first)
- `-t`, `desktop ID N`: move a window to workspace N
- `count N`: set how many workspaces there are, 1 to 16 (root)
