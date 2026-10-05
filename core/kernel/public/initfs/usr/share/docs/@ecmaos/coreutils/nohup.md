# nohup

`man @ecmaos/coreutils/nohup`

## Synopsis

```
nohup COMMAND [ARG]...
```

## Description

Runs COMMAND so that it keeps its output when the terminal is gone. When standard input is a terminal the command reads end of file instead; when standard output is a terminal the output is appended to `nohup.out` (or `~/nohup.out`), with a note on standard error; standard error follows standard output when it was a terminal too.

## Notes

ecmaOS never sends SIGHUP when a terminal closes, so there is no hangup for the command to ignore. The redirection of input and output is what `nohup` does here.

## Exit status

The status of COMMAND; 125 when `nohup` itself failed, 126 when the command cannot run, 127 when it is not found.

## See also

`@ecmaos/coreutils/ecmash`
