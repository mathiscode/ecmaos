# dash

`man @ecmaos/coreutils/dash`

## Synopsis

```
dash [-c COMMAND] [FILE [ARGS]]
dash
```

## Description

dash 0.5.12, the Debian Almquist shell, a small POSIX `sh`, built to WebAssembly and run as an ordinary program in `/bin/dash`. Pipelines, subshells, command substitution and background jobs fork, as on Linux. It reads a script from FILE, a command from `-c`, or commands from the terminal.

It is a second shell beside the kernel's own: the shell that logs in and the one a `#!/bin/sh` script runs under stay the kernel's shell. Run a script under dash by naming it, `dash script.sh`, or with `#!/bin/dash`.

## Examples

```
dash -c 'echo $((6 * 7))'
dash script.sh
```

## See also

`@ecmaos/coreutils-copyleft/bash`, `@ecmaos/coreutils/tmux`

## License

BSD-3-Clause. The license text is in `/usr/share/licenses/@ecmaos/coreutils/dash/`.
