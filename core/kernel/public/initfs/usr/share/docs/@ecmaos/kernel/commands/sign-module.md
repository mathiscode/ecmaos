# sign-module

`man @ecmaos/kernel/commands/sign-module`

## Synopsis

```
sign-module -k KEY [-s SIGNER] [-o OUT] FILE
sign-module --genkey NAME
```

## Description

Signs a kernel module, or makes the key to sign with. The signature is Ed25519 over every byte of the module before the trailer. For a `NAME.ko.mjs` the trailer is appended as a comment block; for a `NAME.ko.wasm` it is a last section of the file. `modinfo` and `insmod` check it without running the module.

`--genkey NAME` writes `NAME.key` (private, mode 600) and `NAME.pub` (public) in the current directory. Copy `NAME.pub` to `/etc/modules-keys` to make the kernel trust what the key signs.

## Options

- `-k, --key KEY`: the private key file
- `-s, --signer NAME`: the signer name in the trailer (default: the key file's name)
- `-o, --output OUT`: write the signed module here instead of over FILE
- `-g, --genkey NAME`: make a key pair
- `--help`: display help and exit

## Exit status

0 on success, 1 on an error.

## See also

`@ecmaos/kernel/commands/modinfo`, `@ecmaos/kernel/commands/insmod`
