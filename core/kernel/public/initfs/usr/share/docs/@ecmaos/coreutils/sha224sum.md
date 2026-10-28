# sha224sum

`man @ecmaos/coreutils/sha224sum`

## Synopsis

```
sha224sum [-c] [--tag] [FILE]...
```

## Description

Print or check SHA-224 checksums, the same way `sha256sum` does for SHA-256. The platform has no SHA-224, so it is computed here.

## Options

```
  -c, --check  read sums from FILEs and check them
      --tag    BSD-style output
      --quiet, --status, -b, -t, -w  as for sha256sum
```

## See also

`sha256sum`, `b2sum`
