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
  read the origin's storage. `/etc/shadow` has the Linux layout
  (`name:hash:lastchg:min:max:warn:inactive:expire:reserved`), with hashes in passlib's
  `$pbkdf2-sha256$rounds$salt$hash` form, and is `0640 root:shadow`. A user's ECDSA key pair is not
  kept there: it is made when first needed and stored in the user's `~/.ssh`, the private half
  encrypted under the login password.
- **Locking an account.** `passwd -l` stops password logins only, as on Linux; a passkey still
  works. To close an account completely, set an expiry date with `chage -E`.
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

### Running in Node (`@ecmaos/node`)

In a Node process the guest is not in a browser sandbox. The kernel writes only inside its data folder, and
WebAssembly programs reach the system only through guest syscalls, but a guest **JavaScript** program runs in a Node
worker thread with Node's full API: it can read the process environment, and read and write any host file the process's
user can. Guest users, `root` included, are not a boundary against the host. Run it with an environment and a working
directory you would hand to the code inside it, and use a container or VM for code you do not trust. See
`core/node/README.md`.

`ecmaos --listen` lets other machines log in with a key. It binds only loopback addresses, because nothing it sends is
encrypted yet (no TLS), so a local process can read the traffic; the login itself is a signature by the user's own key
over a transcript bound to the host and the exchange, and the host's key is pinned by the client on first use. Anyone who
can read a pairing code printed on the host's console can enrol a key for the user it names, once, within ten minutes;
a pairing code is as sensitive as a password for that period.

`--export` hands a host folder to every user who can log in to that machine: read-only unless `:rw`, confined to the folder
(a symbolic link leading out is refused; the check and the use are two steps, so do not export a folder others can rearrange).
Mounting another machine's folder copies it into memory and answers programs from the copy, so it can be stale, and a change
the other machine refuses is only logged.

`--device` (or the `devices` file in the data folder) hands a host device to `root` on a machine that logs in, which gets it as
`/dev/NAME`. Nothing is offered unless listed, a device is read-only unless `:rw` or `:wo` (and the host refuses writes to one
offered read-only, whatever the peer sends), and a device is held by one machine at a time. A `file:` device is whatever file,
FIFO or character device the path names, so list only paths you would let root on the other machine use directly.

## Reporting a Vulnerability

To privately report a security issue, please create a new [Security Advisory](https://github.com/ecmaos/ecmaos/security/advisories/new).
