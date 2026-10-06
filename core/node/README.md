# @ecmaos/node

ecmaOS in a Node process: the same kernel as the browser, with a terminal on your stdin and stdout. Node 24 or newer.

```sh
npx ecmaos                  # a machine in ./.ecmaos
npx ecmaos --data ~/vm      # or in a folder of your choosing (also $ECMAOS_DATA)
npx ecmaos --ephemeral      # a root in memory; nothing is kept
```

## The data folder

Everything the machine persists lives in one folder: `$ECMAOS_DATA`, else `./.ecmaos`. It holds `root.db`
(a SQLite database in WAL mode, with its `-wal` and `-shm` files): the root filesystem, with the owners, modes and
symlinks of its files, and the kernel's settings. Nothing is written outside it, so the folder can be moved, backed up
or deleted as a whole. Commits survive the process being killed; `ECMAOS_SYNCHRONOUS=full` also survives power loss at
a cost in speed. Each file is one row, so very large files are slow and take memory to write.

## Programs

The initfs and the permissively licensed programs of `@ecmaos/coreutils` come with this package, and boot reads them
from disk, with no network. The GPL programs (`vim`, `nano`, `make`, ...) are not part of it: install
`@ecmaos/coreutils-copyleft` beside it to have them (`ECMAOS_COPYLEFT=0` ignores it).
