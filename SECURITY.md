# Security Policy

This is experimental software and no guarantee is made in regards to security or functionality.

Please see the [license](./LICENSE) for more information.

## Threat Model

ecmaOS runs entirely client-side, in the browser, on top of `@zenfs/linux`'s virtual filesystem
persisted to the origin's IndexedDB. This has real consequences for what "security" means here:

- **Same-origin, not local-attacker-resistant.** Anyone with access to the browser profile,
  device, or IndexedDB store for the ecmaOS origin can read the raw filesystem, including
  `/etc/shadow`, directly — no login is required to reach that data at rest. Credential hashing
  and key wrapping protect against *reuse of a leaked hash elsewhere* and against *casual
  inspection*, not against a local attacker with full access to the browser's storage.
- **Password hashing and key derivation** use PBKDF2-SHA256 with a per-user random salt (not a
  memory-hard KDF like Argon2 — WebCrypto does not expose one). This raises the cost of offline
  guessing against a stolen hash; it does not make the hash itself inaccessible to whoever can
  read the origin's storage.
- **Passkeys are the stronger path where available** (`auth.ts`, `tutorials/passkey.md`): the
  private key never leaves the authenticator, so it is not exposed by reading IndexedDB at all.
  Prefer passkeys over passwords when the deployment allows it.
- **There is no server-side trust boundary.** ecmaOS has no backend authority to fall back on;
  all enforcement (syscall allowlists, filesystem permissions, user separation) happens in the
  same browser tab as any code that might be attacking it. Treat every guarantee here as
  organizational and defense-in-depth, not as isolation from a determined local or in-browser
  attacker (e.g. a malicious extension, or an XSS in a co-hosted page sharing the origin).

If your use case requires resistance to local-device attackers or genuine confidentiality at
rest, ecmaOS is not the right tool as currently designed — treat it as a sandboxed, organizational
Unix-like environment for the browser, not a security boundary.

## Reporting a Vulnerability

To privately report a security issue, please create a new [Security Advisory](https://github.com/ecmaos/ecmaos/security/advisories/new).
