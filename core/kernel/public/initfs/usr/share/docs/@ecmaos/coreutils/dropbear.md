# dropbear

`man @ecmaos/coreutils/dropbear`

## Synopsis

```
dropbear [-p [ADDRESS:]PORT] [-F] [-E] [-R]
ssh [-p PORT] [USER@]HOST [COMMAND]
scp [-P PORT] SOURCE DEST
dropbearkey -t TYPE -f FILE
```

## Description

Dropbear 2026.94, a small SSH server and client, built to WebAssembly. `/bin/dropbear` is the server; `ssh` (also `dbclient`), `scp` and `dropbearkey` are links to the same program. The server forks for each connection and each session. A login runs a shell on a pty, a command runs with its status and standard input, and `scp` works in both directions.

The server needs a host key, made with `dropbearkey -t ed25519 -f FILE` and given with `-r`, and is told where to listen with `-p`. A login uses a key (`ssh -i KEY`; `-y` accepts an unknown host key without asking, and `scp` runs `ssh` without it, so the host's key must be in `known_hosts`). `ssh` and `scp` find each other in `/bin`. When the account's shell is the kernel's own, which is a name and not a file to run, the session runs `/bin/sh`.

Known gap: the exit status of a session on a pty is lost.

## Examples

```
dropbearkey -t ed25519 -f /tmp/hostkey
dropbearkey -t ed25519 -f /tmp/id
dropbear -F -E -s -r /tmp/hostkey -p 127.0.0.1:2222 &
ssh -y -i /tmp/id -p 2222 root@127.0.0.1 uname
scp -i /tmp/id -P 2222 file root@127.0.0.1:/tmp/there
```

## See also

`@ecmaos/coreutils/ps`

## License

Dropbear is MIT, with BSD-2-Clause, Zlib and public-domain parts. The license texts are in `/usr/share/licenses/@ecmaos/coreutils/dropbear/`.
