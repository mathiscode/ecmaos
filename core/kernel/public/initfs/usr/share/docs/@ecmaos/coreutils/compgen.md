# compgen

`man @ecmaos/coreutils/compgen`

## Synopsis

```
compgen [-abcdefgjksuv] [-A ACTION] [-G GLOBPAT] [-W WORDLIST] [-X FILTERPAT] [-P PREFIX] [-S SUFFIX] [WORD]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Prints the candidates that start with WORD, one per line, using the same sources as `complete`. It works anywhere, in a script too, which makes it the usual way to filter a word list: `compgen -W "$list" -- "$cur"`. `-W` is expanded first, so variables and substitutions in it work; `-X` filters, and `-P` and `-S` add a prefix and suffix to what is printed.

## Options

- `-a -b -c -d -e -f -g -j -k -s -u -v` - aliases, builtins, commands, directories, exported variables, files, groups, jobs, keywords, services, users, variables
- `-A ACTION` - any action name `complete` takes; an unknown name is `invalid action name`

## Examples

```
compgen -W 'apple avocado banana' a
compgen -A function my_
compgen -f -- src/
```

## Exit status

0, 1 when nothing matches, 2 for a usage error.

## See also

`complete`, `compopt`
