# crypto

`man @ecmaos/coreutils/crypto`

## Synopsis

```
crypto <subcommand> [options]
```

## Subcommands

```
Subcommands:
  generate                    Generate cryptographic keys
  encrypt                     Encrypt data
  decrypt                     Decrypt data
  sign                        Sign data
  verify                      Verify signatures
  import                      Import keys from various formats
  export                      Export keys to various formats
  derive                      Derive keys from passwords or other keys
  random                      Generate random bytes

  --help                      display this help and exit

Run 'crypto <subcommand> --help' for subcommand-specific help.

Examples:

  # Symmetric encryption
  crypto generate --algorithm aes-gcm --length 256 --output key.json
  crypto encrypt --algorithm aes-gcm --key-file key.json --input plaintext.txt --output encrypted.bin
  crypto decrypt --algorithm aes-gcm --key-file key.json --input encrypted.bin --output decrypted.txt

  # ECDSA signing and verification
  crypto generate --algorithm ecdsa --named-curve P-256 --output ecdsa-key.json
  crypto sign --algorithm ecdsa --key-file ecdsa-key.json --input message.txt --output signature.sig
  crypto verify --algorithm ecdsa --key-file ecdsa-key.json --input message.txt --signature signature.sig

  # Key format conversion
  crypto import --format jwk --input key.json --output key.pem
  crypto export --format pkcs8 --input key.pem --output key.json
```
