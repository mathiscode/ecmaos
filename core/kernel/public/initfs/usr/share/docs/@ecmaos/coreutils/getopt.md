# getopt

`man @ecmaos/coreutils/getopt`

## Synopsis

```
getopt OPTSTRING PARAMETERS
getopt [-u] [-n NAME] [-q] -o SHORTOPTS [-l LONGOPTS] -- PARAMETERS
```

## Description

Parse a command line for a shell script, as util-linux's `getopt` does. It prints the options in a normal order, each argument quoted, then `--` and the operands, for `eval set --` to take. `:` after an option letter or long name means an argument is required, `::` an optional one that must be attached. A leading `+` in the option string (or `POSIXLY_CORRECT`) stops at the first operand.

## Options

```
  -o, --options SHORTOPTS   the short options
  -l, --longoptions LIST    the long options, separated by commas
  -n, --name NAME           the name errors are reported under
  -q, --quiet               no error messages
  -Q, --quiet-output        no normal output
  -u, --unquoted            do not quote the output
  -T, --test                exit with status 4 (the enhanced getopt is present)
```

## Example

```
eval set -- "$(getopt -o ab: -l all,out: -- "$@")"
```
