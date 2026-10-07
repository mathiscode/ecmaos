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

## `node` inside the machine

`node` in the guest shell runs JavaScript. It is a real `node` command line:

```sh
node script.js arg1 arg2        # a file, with its arguments (also .mjs and .cjs)
node -e "console.log(1 + 1)"    # evaluate;  -p prints the value
node --input-type=module -e "console.log(await 6 * 7)"
echo "console.log('hi')" | node # a script on standard input (or `node -`)
node                            # on a terminal: the REPL
node -i script.js               # run a file or -e, then the REPL
node -v | -h
```

The REPL is Node's own (`node:repl`), so it has history, completion, multi-line input, `_` and top-level `await`,
plus `.help`, `.editor`, `.save` and `.load` (these two use the machine's filesystem, not yours). `^C` cancels the line,
`^D` leaves. History is kept in `~/.node_repl_history` (`NODE_REPL_HISTORY` moves it; set it to the empty string to turn
it off). It is only available on this host: it needs `node:repl`, which a browser does not have.

`console.log` and `console.error` in a guest program write to the machine's stdout and stderr, so `>` and `|` work on them.
Programs cannot `import` other files or packages yet.

## Logging in from another machine (`--listen`)

```
ecmaos --listen                  # 127.0.0.1:30022
ecmaos --listen=40022            # another port
```

The machine then accepts logins over a WebSocket at `ws://127.0.0.1:30022/ecmaos` and gives each one a shell on a
terminal of its own (TTY 1 to 7; TTY 0 is the console, so seven at once). From another ecmaOS machine, in a browser or
in Node:

```
connect -p 123-456 root@127.0.0.1:30022      # the first time: enrols your key with the one-time code
connect root@127.0.0.1:30022                 # after that, your key is enough
```

On start the host prints its host key fingerprint and a pairing code for `root` (`--pair-user NAME` for someone else,
`--no-pair` for none). The code is six digits, works once, lasts ten minutes and is burned by three wrong guesses.

How it is trusted, in both directions:

- **The host proves who it is** with a key kept in `$ECMAOS_DATA/ecmaosd/host_key.json` (mode 0600). `connect` shows the
  fingerprint the first time and remembers it in `~/.ssh/known_hosts`; a different key later is refused before anything is
  sent. Check the fingerprint against the one the host printed, or give it with `--fingerprint`.
- **You prove who you are** by a signature from your own key (`~/.ssh/id_ecdsa`, an ECDSA P-384 key made the first time it
  is needed and unlocked by your login password) over a transcript that includes both sides' nonces, the host's
  fingerprint and the user name, so it is good for one exchange with one host. The host checks it against the user's
  `~/.ssh/authorized_keys`. Pairing adds your key there.
- A refusal is always the same message, whether the user exists or not, and is held back for a second; three refusals end
  the connection, and ten in a minute make the host stop answering for a while.

### Sharing files between machines

```
ecmaos --listen --export share=/srv/project:rw       # offer a host folder (read-only unless :rw)
mount -t ecmaos root@127.0.0.1:30022/share /mnt/share   # on the other machine: mount it (asks for your password)
share root@127.0.0.1:30022 /home/me/work work       # or from the other machine: offer one of its folders to this host
```

A mount reaches the other machine's files through the same login as `connect`. Read this before relying on it:

- **The folder is copied into memory when it is mounted.** Programs read a mount through a synchronous API, so the machine
  keeps a copy and answers from it. A tree of more than 5000 files or 50 MB is refused (`-o maxfiles=` and `-o maxsize=`
  change that; the memory used is a few times the data).
- **A change made on the other side afterwards is not seen** until the mount is made again.
- **A change made here is accepted at once and sent on in the background.** If the other machine refuses it (a read-only
  export, a permission, the link gone), the machine logs it and the copy no longer matches; the asynchronous API fails
  properly. After the host goes away, reads still work from the copy, changes cannot be sent, and `umount` works.
- **Ownership:** files appear owned by `uid=`/`gid=` (default root); the other machine's owners mean nothing here.
  Symbolic links are shown as links but cannot be created, and nothing is followed out of an exported folder.
- **Who can reach an export:** any user who can log in to the host. Anything exported is exposed to all of them; export a folder you would
  hand to any of them. `share` is accepted only from root.

What it does **not** do yet: **nothing is encrypted**, so only a loopback address can be bound (`--listen=0.0.0.0` is
refused) until TLS is in. Anything else on the machine can read the traffic, and anything that can reach 127.0.0.1 can
try to log in, so it is the key, not the port, that keeps people out. Browsers are additionally held to an allow-list of
pages (`--allow-origin`, repeatable, replacing the default of `https://ecmaos.sh` and `http://localhost:*`), and the
`Host` header must be the loopback name (against DNS rebinding). A client that sends no `Origin` is not a browser and
goes straight to the key check.

The protocol is `@ecmaos/peer`: a binary codec, a version handshake, and channels with credit-based flow control.
The logins here use `auth`, then `tty` (bytes in and out, `resize` messages); files use `fs` (mount an export) and `fs-share` (offer a folder).

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
- **Remote logins** end when the shell exits (`exit`) or the connection drops; whatever was running on the terminal is hung up.

## Tests

- `pnpm --filter @ecmaos/node test` builds the bundle and runs the tests that spawn it: a smoke test, logins over a socket
  (pairing, keys, refusals, two machines using `connect`), persistence across
  processes, lifecycle (halt, poweroff, end of input, SIGTERM, reboot), JavaScript programs, and the terminal on a
  pseudo-terminal (needs `python3`; skipped on Windows).
- `pnpm --filter @ecmaos/kernel test:node` runs the kernel's own tests on Node with no DOM (`vitest.node.config.ts`). The
  files that need a page are listed there, each with its reason, and stay in the jsdom project.
