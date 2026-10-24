# ps

`man @ecmaos/coreutils/ps`

## Synopsis

```
ps [-AadefLlnwZ] [-gG GROUP,] [-k FIELD,] [-o FIELD,] [-p PID,] [-t TTY,] [-uU USER,]
ps aux
```

## Description

Lists processes, from toybox 0.8.12, read from `/proc/<pid>/stat`, `status`, `cmdline` and `exe`. Without options it lists the processes on this terminal; `-e` lists them all, `-f` adds the parent and start time, and `-o` chooses columns (`ps -eo pid,ppid,user,stat,comm`). The BSD spelling `ps aux` (and `ps ax`, `ps u`) works too: a first argument of only `a`, `u`, `x` and `w` is `-e`, with the user columns when it has a `u`.

## Options

Which processes (the selections that take a list accept comma-separated values):

- `-A`, `-e`: all processes
- `-a`: those with a terminal that are not session leaders
- `-d`: all but session leaders
- `-g GROUP`, `-G GROUP`: in these groups, or real groups
- `-p PID` (`--pid`), `-P PID` (`--ppid`): these process IDs, or these parents
- `-s SID`: in these sessions
- `-t TTY`: attached to these terminals
- `-u USER`, `-U USER`: owned by these users, or real users
- `-T`: show threads too

Output:

- `-o FIELD,...`: choose columns, each with an optional `:size` and `=title` (`-o HELP` lists the fields); `-O` adds columns to the defaults
- `-f`: full listing (`-o USER:12=UID,PID,PPID,C,STIME,TTY,TIME,ARGS=CMD`)
- `-l`: long listing (`-o F,S,UID,PID,PPID,C,PRI,NI,ADDR,SZ,WCHAN,TTY,TIME,CMD`)
- `-k FIELD,...` (`--sort`): sort by these fields, `-FIELD` to reverse
- `-n`: numeric USER and GROUP; `-w`: wide output, do not truncate; `-M`: measure and pad future field widths; `-Z`: include LABEL

The default columns are `PID,TTY,TIME,CMD`.

The browser does not tell the kernel how much CPU time or memory a WebAssembly program uses, so TIME is 00:00:00 and %CPU, %MEM, VSZ and RSS are 0. STIME is the hour and minute the process joined the process table (`-o stime:19` gives the date and seconds), in UTC, since a WebAssembly program is not told the browser's time zone; ELAPSED counts from the same moment. A long command line is cut at the width of the terminal, with a `+` at the cut. STAT is `S` (sleeping), `T` (stopped) or `Z` (a zombie), with `s` for a session leader and `+` for the foreground of its terminal.

## Examples

```
ps -ef
ps aux
ps -e -o pid,ppid,stat,comm
ps -o pid,args -p 1
```

## See also

`@ecmaos/coreutils/pidof`, `@ecmaos/kernel/commands/top`, `@ecmaos/kernel/commands/pgrep`, `@ecmaos/kernel/commands/kill`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/ps/`.
