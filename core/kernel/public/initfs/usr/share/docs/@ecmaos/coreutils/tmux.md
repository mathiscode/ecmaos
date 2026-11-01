# tmux

`man @ecmaos/coreutils/tmux`

## Synopsis

```
tmux [COMMAND [FLAGS]]
```

## Description

tmux 3.5a, the terminal multiplexer, with libevent and ncurses, built to WebAssembly and run as an ordinary program. The first client starts a server, which detaches and keeps a pty and a process for each pane, so sessions go on when you detach.

The usual commands work: `tmux` starts a session, `^B c` makes a window, `^B %` and `^B "` split it, `^B d` detaches, `tmux ls` lists the sessions, `tmux attach` returns to one and `tmux kill-server` ends them. `TERM` is `xterm-256color`.

## Examples

```
tmux
tmux new -s build
tmux ls
tmux attach -t build
tmux kill-server
```

## See also

`@ecmaos/coreutils-copyleft/screen`

## License

tmux 3.5a is ISC; it is linked with libevent (BSD-3-Clause) and ncurses (X11). The license texts are in `/usr/share/licenses/@ecmaos/coreutils/tmux/`.
