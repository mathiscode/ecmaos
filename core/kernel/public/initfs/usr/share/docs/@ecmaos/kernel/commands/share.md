# share

`man @ecmaos/kernel/commands/share`

## Synopsis

```
share [OPTIONS] [USER@]HOST[:PORT] PATH [NAME]
share -l
share -d NAME
```

## Description

Offer PATH, a directory of this machine, to another ecmaOS machine started with `ecmaos --listen`. That machine mounts it as
`/mnt/NAME`; NAME defaults to the last part of PATH. It logs in with your key like `connect`, asks for your password to
unlock it, and leaves the link up in the background until `share -d NAME` or until either side ends it.

Only root can share, and the other machine only accepts it from root. The directory is copied into the other machine's
memory when it is mounted, so a large one (over 5000 files or 50 MB) is refused there, and a change made here afterwards is not
seen over there until it is shared again.

## Options

```
  -r, --read-only         the other machine may read it but not change it
  -p, --pair CODE         enrol your key with this one-time pairing code first
  -F, --fingerprint FP    accept the host only if its key has this fingerprint (SHA256:...)
  -y, --accept-new        remember a host seen for the first time
  -l, --list              list what is shared
  -d, --delete NAME       stop sharing NAME
  --help                  display this help and exit
```

## See also

`connect`, `mount -t ecmaos`, `man @ecmaos/kernel/commands/mount`
