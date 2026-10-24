# htop

`man @ecmaos/coreutils-copyleft/htop`

## Synopsis

```
htop [-d DELAY] [-u USER] [-p PID,...] [-s COLUMN] [-t] [-C]
```

## Description

`htop` 3.5.3, the interactive process viewer, built to WebAssembly and run as an ordinary program. It reads `/proc`
as it does on Linux (`stat`, `meminfo`, `loadavg`, each process's `stat`, `status` and `cmdline`) and draws with
ncurses.

The keys are htop's: arrows and Page Up/Down move, `F3` or `/` searches, `F4` or `\` filters, `F5` or `t` shows the
tree, `F6` or `<` `>` picks the column to sort by, `F9` or `k` sends a signal to the selected process, `F2` or `S`
opens the setup screen, `q` or `F10` quits. Settings are kept in `~/.config/htop/htoprc`.

What is shown is what `/proc` says. A browser gives a WebAssembly program no CPU accounting, so the CPU meters and the
`CPU%` and `TIME+` columns read zero, and there is no swap or paging. Memory comes from what the browser reports.
Affinity, hwloc, capabilities and sensors are not built in. `TERM` is `xterm.js`, which no terminal description knows,
so `htop` draws as `xterm-256color`.

## Examples

```
htop
htop -u root
htop -t
```

## See also

`@ecmaos/coreutils/ps`, `@ecmaos/kernel/commands/top`, `@ecmaos/coreutils/vmstat`, `@ecmaos/coreutils/lsof`

## License

GPL-2.0-or-later. The license text and the offer of source are in `/usr/share/licenses/@ecmaos/coreutils-copyleft/htop/`.
