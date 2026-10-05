# env

`man @ecmaos/coreutils/env`

Print the environment, or run a command in a modified one.

## Synopsis

```
env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]
```

## Description

With no `COMMAND`, `env` prints the environment, one `NAME=VALUE` per line. With one, it runs it with the
environment changed by the options and the `NAME=VALUE` assignments before it.

The shells have `env` built in; this is the program behind `/usr/bin/env`, which scripts name in their first
line (`#!/usr/bin/env bash`).

## Options

- `-i`, `--ignore-environment`, `-`: start with an empty environment.
- `-u NAME`, `--unset=NAME`: remove `NAME` from the environment.
- `-0`, `--null`: end each printed line with a NUL instead of a newline.
- `--help`: show usage.

## Exit status

The command's own status; 127 if it cannot be found; 125 if `env` itself failed.

## Examples

```
env GREETING=hi printenv GREETING
env -i /bin/printenv
env -u HOME /bin/printenv HOME
```
