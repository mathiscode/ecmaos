# bash

`man @ecmaos/coreutils-copyleft/bash`

## Synopsis

```
bash [OPTION]... [FILE [ARGS]]
bash -c COMMAND
```

## Description

GNU Bash 5.3, with readline, built to WebAssembly and run as an ordinary program in `/bin/bash`. Arrays, `[[ ]]`, `mapfile`, job control, `PIPESTATUS`, coprocesses, traps and process substitution work, and every command, pipeline and subshell forks as on Linux.

A `#!/bin/bash` script runs under it. It is a second shell beside the kernel's own: the shell that logs in stays the kernel's shell, and `bash` starts this one.

## Examples

```
bash
bash -c 'a=(1 2 3); echo ${#a[@]}'
bash script.sh
```

## See also

`@ecmaos/coreutils/dash`, `@ecmaos/coreutils-copyleft/screen`

## License

GNU Bash 5.3, GPL-3.0-or-later. The license text is in `/usr/share/licenses/@ecmaos/coreutils-copyleft/bash/`. The source it was built from, and what ecmaOS changed, is described in `/usr/share/licenses/@ecmaos/coreutils-copyleft/bash/SOURCE`; the site that served the program also serves the source archive at `/sources/`.
