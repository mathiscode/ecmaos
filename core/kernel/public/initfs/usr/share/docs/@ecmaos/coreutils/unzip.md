# unzip

`man @ecmaos/coreutils/unzip`

## Synopsis

```
unzip [OPTION]... ZIPFILE [FILE]...
```

## Description

Extract files from a zip archive.

## Options

```
  -l, --list       list contents of zip file
  -d, --directory  extract files to directory
  -o, --overwrite  overwrite files without prompting
  -q, --quiet      quiet mode (suppress output)
  -v, --verbose    verbose mode
  -x, --exclude    exclude files from extraction
  -h, --help       display this help and exit

Examples:
  unzip archive.zip
  unzip -d /tmp archive.zip
  unzip -l archive.zip
  unzip -x "*.txt" archive.zip
```
