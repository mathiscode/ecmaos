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

## Security: run only code you trust

`ecmaos` runs as you, and what runs inside it is not sandboxed from the machine it runs on.

- **JavaScript programs are not contained.** A JS program in the guest (a `.js` file run through `/bin/node`) runs in a Node
  worker thread with Node's full API. It can read the process environment (including any secrets in it), read and write
  any file you can, and open network connections, whatever the guest's own users and permissions say. I confirmed this
  by running a guest program that read `process.env`, read `/etc/hostname` on the host and wrote a file there.
- **WebAssembly programs are contained.** `jq`, `vim`, `make` and the rest of the packaged programs reach the system only
  through syscalls into the guest, so they see the guest's filesystem and nothing else.
- **The guest's users are not a boundary against the host.** `root` in the guest has no more reach than any other user
  of it, and none of them is a separate host user.
- **Start it with only what it needs.** Run it in a directory and with an environment you would hand to the code inside it;
  for untrusted code, use a container or a VM, and give it no secrets.
- **What it does guarantee:** the kernel itself writes only inside the data folder (see above), and `--ephemeral` writes
  nowhere. This is a statement about the kernel, not about guest JavaScript.

## Behaviours to know

- **`reboot` starts a new process** with the same arguments, so the old kernel's mounts and workers never carry over.
  The new process reads the same stdin, so on piped input it sees only what is left.
- **End of input** (a script running out, or the terminal closing) halts the machine after the commands already typed have run.
  `halt`, `poweroff`, `SIGTERM` and `SIGHUP` also exit with status 0; a second signal ends the process at once.
- **`^D`** at an empty prompt does nothing yet.
