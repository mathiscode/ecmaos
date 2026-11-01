# dircolors

`man @ecmaos/coreutils/dircolors`

## Synopsis

```
dircolors [-b|-c] [FILE]
dircolors -p
```

## Description

Print the shell commands that set `LS_COLORS`, from FILE or the built-in database (GNU's file format). `eval "$(dircolors -b)"` in `~/.bashrc` is the usual use. Prints nothing useful when `TERM` is not one the database lists.

## Options

```
  -b, --sh           Bourne shell code (the default)
  -c, --csh          C shell code
  -p, --print-database   print the built-in database
      --print-ls-colors  show each entry in its own color
```

## Example

```
eval "$(dircolors -b)"
```
