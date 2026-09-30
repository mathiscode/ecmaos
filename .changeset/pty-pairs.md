---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": patch
---

## Pseudo-terminals: `/dev/ptmx` and `/dev/pts/<n>`

Opening `/dev/ptmx` allocates a master and a slave. The slave is a real tty with a line discipline, termios, a foreground process and `^C` handling; what it writes is what the master reads, and what is written to the master arrives as if typed. The master answers `TIOCGPTN`, `TIOCSPTLCK`, window size and termios ioctls. Closing the last descriptor on a master frees the pair and hangs up the slave.

`@zenfs/core` calls no hook when a device is opened, so the allocation wraps the `open` syscall, as `/dev/fd` already does. `open('/dev/tty')` now reaches the caller's own controlling terminal instead of the console.
