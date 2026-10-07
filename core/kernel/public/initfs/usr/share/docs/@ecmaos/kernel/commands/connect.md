# connect

`man @ecmaos/kernel/commands/connect`

## Synopsis

```
connect [OPTIONS] [USER@]HOST[:PORT]
connect [OPTIONS] ws://HOST:PORT[/ecmaos]
```

## Description

Log in to an ecmaOS machine started with `ecmaos --listen` and get a shell on it, like `ssh`. The default port is 30022.

You prove who you are with your own key, `~/.ssh/id_ecdsa` (an ECDSA P-384 key, made the first time it is needed and
unlocked by your login password, which is asked for once per connection). The machine proves who it is with its host
key, which is remembered in `~/.ssh/known_hosts` the first time you connect; a different key later is refused before
anything is sent. Check the fingerprint it shows against the one the machine printed when it started.

The first time a key is used with a machine, enrol it with the one-time pairing code the machine prints:
`connect -p 123-456 root@127.0.0.1:30022`. After that the key alone is enough.

Nothing is encrypted yet, so a machine only listens on a loopback address.

## Options

```
  -l, --login USER        the user to log in as (default: you)
  -p, --pair CODE         enrol your key with this one-time pairing code, then log in
  -F, --fingerprint FP    accept the host only if its key has this fingerprint (SHA256:...)
  -y, --accept-new        remember a host seen for the first time without asking
  --help                  display this help and exit
```

## Exit status

0 when the session ended normally, 255 when the connection or the login failed.

## Files

`~/.ssh/id_ecdsa`, `~/.ssh/id_ecdsa.pub`, `~/.ssh/known_hosts` (here); `~/.ssh/authorized_keys` (on the machine logged in to).

## See also

`nc`, `man @ecmaos/kernel/commands/nc`
