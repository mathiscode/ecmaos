# chown

`man @ecmaos/coreutils/chown`

## Synopsis

```
chown [OPTION]... [OWNER][:[GROUP]] FILE...
or:  chown [OPTION]... :GROUP FILE...
or:  chown [OPTION]... --reference=RFILE FILE...
```

## Description

Change the owner and/or group of each FILE to OWNER and/or GROUP.

## Options

```
      -R, --recursive     operate on files and directories recursively
      -v, --verbose       output a diagnostic for every file processed
      -c, --changes       like verbose but report only when a change is made
      --help              display this help and exit

OWNER and GROUP can be specified as:
  - A numeric user ID (UID) or group ID (GID)
  - A username (resolved to UID)
  - A group name (resolved to GID, if supported)

The format OWNER:GROUP means set both owner and group.
The format OWNER: means set owner and set group to owner's primary group.
The format :GROUP means set group only (keep current owner).
The format OWNER.GROUP is also accepted (same as OWNER:GROUP).

Examples:
  chown root file                 Change owner of file to root
  chown root:root file            Change owner and group to root
  chown :users file               Change group to users (keep owner)
  chown root: file                Change owner to root, group to root's primary group
  chown -R root:root /dir         Recursively change owner and group
  chown -v user file              Verbose output while changing owner
  chown -c user file              Report only when changes are made
```
