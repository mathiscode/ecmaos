# user

`man @ecmaos/kernel/commands/user`

## Synopsis

```
user [COMMAND] [OPTIONS] [USERNAME]
```

## Description

Manage users on the system.

## Options

```
Commands:
  add USERNAME     Add a new user
  del USERNAME     Delete a user
  mod USERNAME     Modify a user
  list             List all users (default)

Options for 'add':
  -m, --create-home    Create home directory
  -s, --shell SHELL    Login shell (default: ecmaos)
  -g, --gid GID        Group ID (default: same as UID)
  -u, --uid UID        User ID (default: auto-assigned)
  -p, --password PASS  Password (will prompt if not provided)

Options for 'del':
  -r, --remove-home    Remove home directory

Options for 'mod':
  -s, --shell SHELL    Change login shell
  -g, --gid GID        Change group ID
  -p, --password       Change password (will prompt)

  --help               Display this help and exit
```

## See also

`user --help`
