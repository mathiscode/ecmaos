# ssh-keygen

`man @ecmaos/coreutils/ssh-keygen`

## Synopsis

```
ssh-keygen [-q] [-t TYPE] [-b BITS] [-C COMMENT] [-f FILE] [-N ""]
ssh-keygen -y -f FILE
ssh-keygen -l -f FILE
```

## Description

Make a key pair in OpenSSH's format, using the browser's WebCrypto. The private key is written to `FILE` (mode 600) and the public key to `FILE.pub`; `FILE` defaults to `~/.ssh/id_TYPE`, and `~/.ssh` is made if needed. If `FILE` exists it asks `Overwrite (y/n)?` on standard input and stops unless the answer is yes.

`-y` prints the public key of a private key. `-l` prints a key's size and SHA256 fingerprint, as `256 SHA256:... comment (ED25519)`; `FILE` may be a private or a public key. OpenSSH reads what this writes and reports the same public key and fingerprint.

Differences from OpenSSH's `ssh-keygen`: it asks nothing (the file name is a default, not a prompt), there is no passphrase (keys are written unencrypted, and `-N` with anything but an empty string is refused), the randomart image is not printed, and the other modes (certificates, known_hosts, moduli, signing) are not provided. `dropbearkey` makes keys in Dropbear's own format.

## Options

```
  -t TYPE     ed25519 (the default), rsa or ecdsa
  -b BITS     rsa: 1024 to 16384 (default 3072); ecdsa: 256, 384 or 521 (default 256)
  -C COMMENT  the comment (default USER@HOSTNAME)
  -f FILE     the key file
  -N ""       the passphrase, which can only be empty
  -q          print nothing
  -y          print the public key of the private key in FILE
  -l          print the fingerprint of the key in FILE
```

## See also

`ssh`, `dropbear`, `crypto`
