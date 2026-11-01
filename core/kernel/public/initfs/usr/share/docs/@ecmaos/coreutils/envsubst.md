# envsubst

`man @ecmaos/coreutils/envsubst`

## Synopsis

```
envsubst [-v] [SHELL-FORMAT]
```

## Description

Copy standard input to standard output, replacing `$VAR` and `${VAR}` with the environment's values; an unset variable becomes empty. With a SHELL-FORMAT such as `'$HOME $USER'` only the variables it names are replaced. `-v` lists the variables a format refers to.

## Options

```
  -v, --variables   output the variables occurring in SHELL-FORMAT
  -h, --help        display this help and exit
```

## Example

```
NAME=world envsubst <<< 'hello $NAME'
```
