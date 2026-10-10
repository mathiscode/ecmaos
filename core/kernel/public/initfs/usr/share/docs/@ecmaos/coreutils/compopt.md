# compopt

`man @ecmaos/coreutils/compopt`

## Synopsis

```
compopt [-o|+o OPTION] [-DEI] [NAME ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Changes the options of a completion specification: `-o` turns an option on and `+o` off. With no NAME it changes the completion being run, so a `-F` function can call it (`compopt -o nospace`); anywhere else that is an error (`not currently executing completion function`).

## Exit status

0, or 1 when there is no such specification or no completion is running.

## See also

`complete`, `compgen`
