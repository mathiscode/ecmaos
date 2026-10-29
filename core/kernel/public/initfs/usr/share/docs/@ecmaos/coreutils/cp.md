# cp

`man @ecmaos/coreutils/cp`

## Synopsis

```
cp [OPTION]... SOURCE... DEST
```

## Description

Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.

A file or directory that does not exist yet is created with its source's permission bits, without setuid, setgid or sticky, so a copied program stays executable. A destination that already exists keeps its own mode. There is no umask, so the bits are copied as they are.

## Options

```
  -r, -R, --recursive   copy directories recursively
  -p, --preserve        keep the mode (setuid and sticky bits too), the access and modification times and, for root, the owner
  -v, --verbose         explain what is being done
  --help                display this help and exit
```
