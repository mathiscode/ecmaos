# zip

`man @ecmaos/kernel/commands/zip`

## Synopsis

```
zip [OPTION]... ZIPFILE FILE...
```

## Description

Create a zip archive containing the specified files and directories.

## Options

```
  -r, --recurse    recurse into directories
  -l, --list       list contents of zip file
  -v, --verbose    verbose mode
  -h, --help       display this help and exit

Examples:
  zip archive.zip file1.txt file2.txt
  zip -r archive.zip directory/
  zip -l archive.zip
```

## See also

`zip --help`
