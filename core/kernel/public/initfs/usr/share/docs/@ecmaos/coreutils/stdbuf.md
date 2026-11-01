# stdbuf

`man @ecmaos/coreutils/stdbuf`

## Synopsis

```
stdbuf OPTION... COMMAND
```

## Description

Run COMMAND with modified buffering for its standard streams. On Linux this preloads a library into the program; here there is none to preload and the streams pass bytes as they are written, so the modes are checked and accepted and the command runs as it is.

## Options

```
  -i, --input=MODE   standard input buffering
  -o, --output=MODE  standard output buffering
  -e, --error=MODE   standard error buffering
MODE is L (line buffered), 0 (unbuffered) or a size such as 4K.
```

## Example

```
tail -f log | stdbuf -oL grep error
```
