# format

`man @ecmaos/kernel/commands/format`

## Synopsis

```
format [OPTION]...
```

## Description

Delete all IndexedDB and localStorage data.

## Options

```
  -i, --indexeddb        Delete only IndexedDB databases
  -l, --localstorage     Delete only localStorage
  -k, --keep <name>      Preserve specific IndexedDB database(s) (can be used multiple times)
  --help                 Display this help and exit

By default, deletes all IndexedDB databases and localStorage.
Requires root privileges and interactive confirmation.
```

## See also

`format --help`
