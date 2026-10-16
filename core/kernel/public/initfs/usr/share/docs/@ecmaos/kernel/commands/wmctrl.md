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

- `-l`, `list`: list windows as id, state, owner pid and title
- `-a`, `focus ID`: raise and focus a window
- `-c`, `close ID`: close a window
- `minimize ID`, `maximize ID`, `restore ID`, `fullscreen ID`: change a window's state
- `move ID X Y`, `resize ID WIDTH HEIGHT`: change a window's geometry
- `title ID TEXT...`: set a window's title
