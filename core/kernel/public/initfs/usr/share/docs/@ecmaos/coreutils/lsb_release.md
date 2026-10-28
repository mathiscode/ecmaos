# lsb_release

`man @ecmaos/coreutils/lsb_release`

## Synopsis

```
lsb_release [-i] [-d] [-r] [-c] [-a] [-s]
```

## Description

Print the distribution's identity, read from `/etc/os-release`: `NAME` as the distributor ID, `PRETTY_NAME` as the description, `VERSION_ID` as the release and `VERSION_CODENAME` as the codename. A field the file does not have prints `n/a` (the release prints `rolling`). With no option, everything is printed.

## Options

```
  -i, --id           the distributor ID
  -d, --description  the description
  -r, --release      the release number
  -c, --codename     the code name
  -a, --all          all of the above, and the LSB version (always n/a)
  -s, --short        only the values
  -v, --version      the LSB version
```

## See also

`uname`, `fastfetch`, `/etc/os-release`
