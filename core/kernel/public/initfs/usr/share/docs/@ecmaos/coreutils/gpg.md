# gpg

`man @ecmaos/coreutils/gpg`

## Synopsis

```
gpg [OPTIONS] COMMAND [FILES]
```

## Description

Make OpenPGP keys, sign, verify, encrypt and decrypt, compatible with GnuPG for the algorithms below. The OpenPGP code is written for ecmaOS over WebCrypto; it is not GnuPG.

What it supports:

- **Keys**: v4 RSA (2048, 3072, 4096), Ed25519 for signing, and Curve25519 (cv25519) for encryption
- **Hashes**: SHA-1, SHA-224, SHA-256, SHA-384 and SHA-512
- **Ciphers**: AES-128, AES-192 and AES-256
- **Encrypted data**: SEIPD with a modification detection code
- **Compression**: ZIP and ZLIB can be read; nothing it writes is compressed

**Making keys.** `--quick-gen-key USER-ID [ALGO [USAGE [EXPIRE]]]` makes a key pair. By default that is an ed25519 primary key for signing and certifying, a cv25519 subkey for encrypting, and three years before it expires. ALGO can be `rsa2048`, `rsa3072` or `rsa4096`, and EXPIRE can be `0` or `never`, or a number of days, weeks, months or years (`2y`). `--gen-key` asks for a name and email first.

**Passphrases.** A secret key is protected with AES-256, its passphrase stretched with iterated SHA-256. There is no gpg-agent, so the passphrase is asked for on the terminal each time a secret key is used. `--passphrase`, `--passphrase-file` or `--passphrase-fd` gives it instead, which is how `--batch` use works.

**Keyrings.** The keys are kept in `pubring.gpg` and `secring.gpg` in `$GNUPGHOME` (`~/.gnupg`, mode 0700). These are plain OpenPGP files, not GnuPG 2's keybox and private-keys directory, so any OpenPGP program can read them. Keys move between this and GnuPG with `--export`, `--export-secret-keys` and `--import`.

**Trust.** There is no web of trust. A key with its secret part here is ultimately trusted, and any other key is of unknown validity. Verifying a signature from an unknown key warns, as GnuPG does. Encrypting to one asks first, and fails in `--batch` mode, unless `--trust-model always` (or `--always-trust`) is given.

**Output files.** With a file and no `-o`, the output goes beside the input: `FILE.gpg`, `FILE.asc` when armored, or `FILE.sig` for a detached signature. An existing file is replaced only after asking, or with `--yes`.

**Not supported**: DSA and ElGamal keys, v5 and v6 keys and AEAD, key servers, revocation certificates, signing and editing keys (`--sign-key`, `--edit-key`), and the agent and smart cards.

## Exit status

`--verify` returns 0 for a good signature, 1 for a bad one, and 2 when the key is missing. Other errors return 2.

## Commands

```
  -s, --sign / --clear-sign / -b, --detach-sign
  -e, --encrypt (-r USER-ID)    -c, --symmetric    -se: sign and encrypt
  -d, --decrypt                 --verify SIG [DATA]
  -k, --list-keys   -K, --list-secret-keys   --fingerprint   --list-signatures
  --quick-gen-key / --gen-key / --full-gen-key
  --import [FILE]...   --export [-a] [KEY]...   --export-secret-keys [KEY]...
  --delete-keys / --delete-secret-keys / --delete-secret-and-public-keys KEY...
  --enarmor / --dearmor   --print-md ALGO [FILE]...   --gen-random 0|1|2 N
```

With no command, a file is decrypted, checked, or listed if it holds keys, as GnuPG guesses.

## Options

```
  -a, --armor  -o, --output FILE  -r, --recipient KEY  -u, --local-user KEY  -t, --textmode
  --homedir DIR  --batch  --yes  --passphrase S  --passphrase-file F  --passphrase-fd N
  --trust-model always  --digest-algo SHA512|SHA384|SHA256|SHA224|SHA1  --cipher-algo AES256|AES192|AES
  --with-colons  --pinentry-mode loopback (accepted)
```

A KEY is a fingerprint, a long or short key ID, or part of a user ID (`<email>` for an exact address).

## See also

`ssh-keygen`, `sha256sum`
