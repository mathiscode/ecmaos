# sed

`man @ecmaos/coreutils/sed`

## Synopsis

```
sed [OPTION]... {script-only-if-no-other-script} [input-file]...
```

## Description

See the options below.

Patterns are basic regular expressions, or extended with `-E`. A last line with no newline is written without one. `N` on the last line prints the pattern space and stops, as GNU does. Not implemented: the `e` command and the `s///e` flag.

## Options

```
  -n, --quiet, --silent       suppress automatic printing of pattern space
  -e script, --expression=script  add the script to the commands to be executed
  -f script-file, --file=script-file  add the contents of script-file to the commands to be executed
  -E, -r, --regexp-extended   use extended regular expressions in the script
  -i[SUFFIX], --in-place[=SUFFIX]  edit files in place (makes backup if SUFFIX supplied)
  -s, --separate              consider files as separate rather than as a single continuous long stream
  -z, --null-data             separate lines by NUL characters
  -u, --unbuffered            (ignored)
  -l N, --line-length=N       specify the desired line-wrap length for the 'l' command
  --help                      display this help and exit

If no -e, --expression, -f, or --file option is given, then the first non-option argument is taken as the sed script to interpret.
```

## See also

`sed --help`
