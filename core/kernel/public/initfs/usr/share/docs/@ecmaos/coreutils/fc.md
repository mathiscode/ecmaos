# fc

`man @ecmaos/coreutils/fc`

## Synopsis

```
fc [-e ENAME] [-lnr] [FIRST] [LAST]
fc -s [PAT=REP] [COMMAND]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Lists, edits or re-runs commands from the history, which both shells keep in `~/.ecmash_history`. The `fc` line itself is not counted. In a script or `ecmash -c` there is no history, so it reports `fc: no command found`.

FIRST and LAST are history numbers, negative ones counting back from the last command, or the start of a command (the most recent one beginning with that text). Listing defaults to the last 16 commands; editing defaults to the last one.

## Options

- `-l` - list the commands instead of editing them
- `-n` - leave the numbers out of the list
- `-r` - reverse the order
- `-s` - run COMMAND again (the most recent by default) after replacing the first PAT in it with REP; the command is shown first
- `-e ENAME` - edit the commands in ENAME, then run what comes back; the default is `$FCEDIT`, `$EDITOR`, then `vim`. `-e -` is the same as `-s`

## Examples

```
fc -l -5            # the last five commands
fc -s ls=ll         # run the last ls command again as ll
fc -e nano 10 12    # edit commands 10 to 12 and run the result
```

## Exit status

0, or 1 when no command matches; with `-s` and the editing form, the status of what was run.

## See also

`@ecmaos/kernel/commands/history`, `@ecmaos/coreutils/ecmash`
