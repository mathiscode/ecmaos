# mount

`man @ecmaos/kernel/commands/mount`

## Synopsis

```
mount [OPTIONS] [SOURCE] TARGET
mount [-a|--all]
mount [-l|--list]
```

## Description

Mount a filesystem.

## Options

```
Options:
  -t, --type TYPE     filesystem type
  -o, --options OPTS  mount options (comma-separated key=value pairs)
  -a, --all           mount all filesystems listed in /etc/fstab
  -l, --list          list all mounted filesystems
  --help              display this help and exit

Filesystem types:
  fetch               mount a remote filesystem via HTTP fetch
  indexeddb           mount an IndexedDB-backed filesystem
  webstorage          mount a WebStorage-backed filesystem (localStorage or sessionStorage)
  webaccess           mount a filesystem using the File System Access API (interactive picker)
  opfs                mount the browser's Origin Private File System (no picker, sandboxed per-origin)
  memory              mount an in-memory filesystem
  singlebuffer        mount a filesystem backed by a single buffer
  zip                 mount a readonly filesystem from a zip archive (requires SOURCE file or URL)
  iso                 mount a readonly filesystem from an ISO image (requires SOURCE file or URL)
  googledrive         mount a Google Drive filesystem (requires apiKey via -o apiKey, optionally clientId for OAuth)
  ecmaos              mount a directory of another ecmaOS machine (SOURCE is [wss://][user@]host[:port][/export]; wss:// for a host serving TLS); asks for your password,
                      which unlocks the key that logs in. The directory is copied into memory: see the options below

Mount options:
  baseUrl=URL         base URL for fetch operations (fetch type)
  size=BYTES          buffer size in bytes for singlebuffer type (default: 1048576)
  storage=TYPE        storage type for webstorage (localStorage or sessionStorage, default: localStorage)
  apiKey=KEY          Google API key (googledrive type, required)
  clientId=ID         Google OAuth client ID (googledrive type, optional)
  scope=SCOPE         OAuth scope (googledrive type, default: https://www.googleapis.com/auth/drive)
  cacheTTL=SECONDS    cache TTL in seconds for cloud backends (optional)
  maxfiles=N          ecmaos: refuse a tree of more files than this (default 5000)
  maxsize=SIZE        ecmaos: refuse a tree larger than this, e.g. 50M (default 50M)
  pair=CODE           ecmaos: enrol your key with this one-time pairing code first
  fingerprint=FP      ecmaos: accept a host not seen before if its key has this fingerprint
  accept-new=yes      ecmaos: remember a host seen for the first time
  uid=N,gid=N         ecmaos: who the files appear to belong to here (default 0)

Examples:
  mount -l                                    list all mounted filesystems
  mount -t memory /mnt/tmp                    mount memory filesystem at /mnt/tmp
  mount -t indexeddb mydb /mnt/db             mount IndexedDB store 'mydb' at /mnt/db
  mount -t webstorage /mnt/storage            mount WebStorage filesystem using localStorage
  mount -t webstorage /mnt/storage -o storage=sessionStorage
  mount -t webaccess /mnt/access              mount File System Access API filesystem
  mount -t opfs /mnt/opfs                     mount the Origin Private File System
  mount -t fetch /api /mnt/api                mount fetch filesystem at /mnt/api
  mount -t fetch /api /mnt/api -o baseUrl=https://example.com
  mount -t singlebuffer /mnt/buf              mount singlebuffer filesystem at /mnt/buf
  mount -t singlebuffer /mnt/buf -o size=2097152
  mount -t zip https://example.com/archive.zip /mnt/zip
  mount -t zip /tmp/archive.zip /mnt/zip
  mount -t iso https://example.com/image.iso /mnt/iso
  mount -t iso /tmp/image.iso /mnt/iso
  mount -t googledrive /mnt/gdrive -o apiKey=YOUR_API_KEY # readonly/public
  mount -t googledrive /mnt/gdrive -o clientId=YOUR_CLIENT_ID # rw/private
  mount -t ecmaos root@127.0.0.1:30022/share /mnt/share
```

## Permissions

Only root may mount or unmount a filesystem; listing the mounts (`mount` with no arguments) is open to everyone.

## See also

`mount --help`
