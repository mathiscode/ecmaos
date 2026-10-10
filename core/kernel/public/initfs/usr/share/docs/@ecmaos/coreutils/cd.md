# cd

`man @ecmaos/coreutils/cd`

## Synopsis

```
cd [DIRECTORY]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Changes the working directory to DIRECTORY, or to `$HOME` with no argument. `cd -` goes to `$OLDPWD` and prints it. A leading `~` is expanded. `PWD` and `OLDPWD` are updated. The working directory belongs to the shell and is not remembered between logins: a login shell starts in `$HOME`.

## Examples

```
cd /tmp
cd -        # back, printing the old directory
cd         # home
```

## Exit status

0, or 1 when the directory does not exist, is not a directory, or `HOME` or `OLDPWD` is needed and unset.

## See also

`pwd`, `pushd`, `popd`
