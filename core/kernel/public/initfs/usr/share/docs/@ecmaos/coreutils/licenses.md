# licenses

`man @ecmaos/coreutils/licenses`

## Synopsis

```
licenses [NAME...]
```

## Description

Lists the licenses of the software ecmaOS is made of, from `/usr/share/licenses`: ecmaOS itself (MIT OR Apache-2.0), the libraries it is built on (ZenFS, `utilium` and `memium`, all LGPL-3.0-or-later) and the programs it ships, those of `@ecmaos/coreutils` and of `@ecmaos/coreutils-copyleft`, each with its license and where its texts are.

With a `NAME` it prints every text and notice kept for it: `licenses zenfs/core`, `licenses utilium`, `licenses bash`. For a copyleft program that includes `SOURCE`, the written offer of the source the binary was built from. For the libraries, `/usr/share/licenses/@zenfs/README.md` says how to build ecmaOS against a copy of your own.

## Examples

```
licenses
licenses zenfs/core
licenses bash
licenses | grep GPL
```

## See also

`@ecmaos/coreutils/man`

## License

MIT OR Apache-2.0.
