# man

`man @ecmaos/coreutils/man`

## Synopsis

```
man [OPTION]... [@scope/]package[/topic[/subtopic...]]
```

## Description

Display manual pages.

## Options

```
  -l, --list    list available topics for a package
  --where PATH  override default documentation path
  --help        display this help and exit

Examples:
  man ps                         display the page for the command ps
  man package-name               display index for package-name
  man @scope/package             display index for @scope/package
  man -l @scope/package          list topics for @scope/package
  man package-name/topic         display topic from package-name
  man @scope/package/docs        display docs/index from @scope/package
```
