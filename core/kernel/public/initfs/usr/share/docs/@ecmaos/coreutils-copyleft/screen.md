# screen

`man @ecmaos/coreutils-copyleft/screen`

## Synopsis

```
screen [-S NAME] [COMMAND [ARGS]]
screen [-S NAME] DEVICE [BAUD[,OPTIONS]]
screen -ls
screen -r [NAME]
screen -S NAME -X COMMAND
```

## Description

GNU screen 5.0.1, the terminal multiplexer, built to WebAssembly and run as an ordinary program. It keeps windows,
each with a shell or a program in it, on a server that goes on when you detach, and draws them with ncurses's
termcap on the terminal it is started from.

The commands are the usual ones, after `^A`: `c` makes a window, `n` and `p` go to the next and previous, `"` lists
them, `d` detaches, `k` kills a window, `[` scrolls back, `?` shows the keys. `screen -ls` lists the sessions,
`screen -r NAME` returns to one, and `screen -S NAME -X COMMAND` sends a command to a running session (`quit`,
`stuff 'ls\r'`, `hardcopy FILE`).

A device in place of a command makes the window a terminal on it: `screen /dev/ttyACM0 115200` talks to a board
(Arduino, Raspberry Pi Pico, ESP32) through `/dev/ttyACM<N>`, `/dev/ttyUSB<N>` or `/dev/rfcomm<N>`; after the speed
come the settings, as in `115200,cs8,-parenb`. `^A k` ends the window and closes the port.

The sockets of the sessions are in `~/.screen`, where `screen -ls` and `-r` find them. Each is a socket file, with
the mode screen sets on it to tell an attached session from a detached one.

Windows run `$SHELL`; the kernel's own shell is not a file to run, so `/bin/sh` is used then. `TERM` is `xterm.js`,
which no terminal description knows, so `screen` draws as `xterm-256color`. There is no utmp here, so no login
records are kept, and no PAM, so no lock screen password.

## Examples

```
screen
screen -S build
screen /dev/ttyACM0 115200
screen -ls
screen -r build
screen -S build -X quit
```

## License

GNU screen 5.0.1, GPL-3.0-or-later, linked with ncurses 6.5 (X11 license). The license text is in `/usr/share/licenses/@ecmaos/coreutils-copyleft/screen/`. The source it was built from, and what ecmaOS changed, is described in `/usr/share/licenses/@ecmaos/coreutils-copyleft/screen/SOURCE`; the site that served the program also serves the source archive at `/sources/`.
