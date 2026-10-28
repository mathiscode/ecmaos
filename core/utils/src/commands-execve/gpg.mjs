/**
 * `gpg`: OpenPGP keys, signatures and encryption, compatible with GnuPG for what it does. The OpenPGP code is written
 * here (`lib/openpgp/`) over WebCrypto: v4 keys of RSA, Ed25519 (EdDSA) and Curve25519 (ECDH); SHA-1/224/256/384/512;
 * AES-128/192/256; ZIP and ZLIB on reading. Keys are generated, listed, imported, exported and deleted; data is signed
 * (inline, cleartext, detached), verified, encrypted to keys and with a passphrase, and decrypted.
 *
 * The keyrings are OpenPGP files, `pubring.gpg` and `secring.gpg` in `$GNUPGHOME` (`~/.gnupg`), not GnuPG 2's keybox and
 * agent store, so they can be read by any OpenPGP program. There is no agent: a passphrase is asked for on the terminal
 * each time (or taken from `--passphrase`, `--passphrase-file` or `--passphrase-fd`). There is no web of trust either:
 * keys with a secret part here are ultimately trusted and the others are of unknown validity, so encrypting to one asks
 * first unless `--trust-model always`. Not done: DSA and ElGamal keys, v5/v6 keys and AEAD, key servers, revocation
 * certificates, signing other keys, editing keys.
 */

import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { ttyFd } from './lib/tty.mjs'
import { HASH_IDS, concat, hash, random } from './lib/openpgp/crypto.mjs'
import { TAG, armor, binaryOf, dearmor, hex, isArmored } from './lib/openpgp/packets.mjs'
import { ALGO, algoName, fingerprintText, generateKey, isProtected, keyidText, matches, readKeys, unlock, usageLetters, validate, writeKey } from './lib/openpgp/keys.mjs'
import { checkSignature, cipherName, decryptData, encrypt, literal, openMessage, sessionFromPkesk, sessionFromSkesk, signClear, signDetached, signInline } from './lib/openpgp/messages.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, writeAll, open, close, read, stat, mkdir, rename, chmod, tcgetattr, tcsetattr, O_WRONLY, O_CREAT, O_TRUNC } = sys
const O_RDWR = 2
const ECHO = 0o10
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const say = text => writeAll(2, encoder.encode(`gpg: ${text}\n`))
const raw = text => writeAll(2, encoder.encode(text))

class Fail extends Error { constructor(message, code = 2) { super(message); this.code = code } }

const usage = `gpg (ecmaOS OpenPGP) 1.0

Syntax: gpg [options] [files]
Sign, check, encrypt or decrypt
Default operation depends on the input data

Commands:

 -s, --sign                  make a signature
     --clear-sign            make a clear text signature
 -b, --detach-sign           make a detached signature
 -e, --encrypt               encrypt data
 -c, --symmetric             encryption only with symmetric cipher
 -d, --decrypt               decrypt data (default)
     --verify                verify a signature
 -k, --list-keys             list keys
     --list-signatures       list keys and signatures
     --check-signatures      list and check key signatures
     --fingerprint           list keys and fingerprints
 -K, --list-secret-keys      list secret keys
     --quick-generate-key    quickly generate a new key pair
     --generate-key          generate a new key pair
     --full-generate-key     full featured key pair generation
     --delete-keys           remove keys from the public keyring
     --delete-secret-keys    remove keys from the secret keyring
     --export                export keys
     --export-secret-keys    export secret keys
     --import                import/merge keys
     --enarmor               wrap binary data in ASCII armor
     --dearmor               unwrap ASCII armor
     --print-md ALGO         print message digests
     --gen-random 0|1|2 N    output N random bytes

Options:

 -a, --armor                 create ascii armored output
 -r, --recipient USER-ID     encrypt for USER-ID
 -u, --local-user USER-ID    use USER-ID to sign or decrypt
 -o, --output FILE           write output to FILE
 -t, --textmode              use canonical text mode
     --homedir DIR           use DIR instead of ~/.gnupg
     --batch                 never ask
     --yes                   assume yes on most questions
     --passphrase STRING     use STRING as the passphrase
     --passphrase-file FILE  read the passphrase from FILE
     --passphrase-fd N       read the passphrase from descriptor N
     --pinentry-mode loopback  (accepted; passphrases are always asked here)
     --trust-model always    use keys of unknown validity without asking
     --digest-algo NAME      SHA256, SHA384, SHA512 (default), SHA224, SHA1
     --with-colons           machine-readable listings`

// Prompts --------------------------------------------------------------------------------------------------------------

function terminal() {
  try { return open('/dev/tty', O_RDWR, 0) } catch { return -1 }
}

function readLine(fd) {
  const bytes = []
  const one = new Uint8Array(1)
  for (;;) {
    const n = read(fd, one, -1)
    if (n <= 0) return bytes.length ? decoder.decode(new Uint8Array(bytes)) : null
    if (one[0] === 10) return decoder.decode(new Uint8Array(bytes))
    if (one[0] !== 13) bytes.push(one[0])
  }
}

function ask(o, question, hidden = false) {
  if (o.batch) throw new Fail('Sorry, we are in batchmode - can\'t get input')
  const fd = ttyFd() >= 0 ? terminal() : -1
  if (fd < 0) throw new Fail('cannot open \'/dev/tty\': No such device or address')
  let lflag
  try {
    writeAll(fd, encoder.encode(question))
    if (hidden) { lflag = tcgetattr(fd).lflag; tcsetattr(fd, { lflag: lflag & ~ECHO }) }
    const answer = readLine(fd)
    if (hidden) writeAll(fd, encoder.encode('\n'))
    return answer ?? ''
  } finally {
    if (lflag !== undefined) tcsetattr(fd, { lflag })
    close(fd)
  }
}

const confirm = (o, question) => o.yes || /^y(es)?$/i.test(ask(o, `${question} (y/N) `).trim())

/** The passphrase given on the command line or from a file or descriptor, else undefined */
function givenPassphrase(o) {
  if (o.passphrase !== undefined) return o.passphrase
  if (o.passphraseFile !== undefined) {
    try { return decoder.decode(readFileBytes(o.passphraseFile)).split('\n')[0] } catch (error) { throw new Fail(`can't open '${o.passphraseFile}': ${reasonOf(error)}`) }
  }
  if (o.passphraseFd !== undefined) {
    const line = readLine(o.passphraseFd)
    o.passphrase = line ?? ''
    return o.passphrase
  }
  return undefined
}

function askPassphrase(o, prompt, twice = false) {
  const given = givenPassphrase(o)
  if (given !== undefined) return given
  for (;;) {
    const first = ask(o, `${prompt}\nPassphrase: `, true)
    if (!twice) return first
    const second = ask(o, 'Repeat: ', true)
    if (first === second) return first
    raw('Passphrases do not match; try again.\n')
  }
}

// The keyrings ---------------------------------------------------------------------------------------------------------

function homeDir(o) {
  return o.homedir ?? env.GNUPGHOME ?? `${(env.HOME ?? '/root').replace(/\/$/, '')}/.gnupg`
}

const exists = path => { try { stat(path); return true } catch { return false } }

function ensureHome(o) {
  const home = homeDir(o)
  if (!exists(home)) {
    mkdir(home, 0o700)
    say(`directory '${home}' created`)
  }
  return home
}

function writeFileAtomic(path, bytes, mode = 0o600) {
  const temporary = `${path}.tmp${Math.random().toString(36).slice(2, 8)}`
  const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, mode)
  try { writeAll(fd, bytes) } finally { close(fd) }
  chmod(temporary, mode)
  rename(temporary, path)
}

async function loadRing(path) {
  if (!exists(path)) return []
  return await readKeys(readFileBytes(path))
}

/** Both keyrings, as one list of keys by fingerprint: `{ pub, sec }` each */
async function loadKeyring(o) {
  const home = homeDir(o)
  const keys = new Map()
  for (const key of await loadRing(`${home}/pubring.gpg`)) keys.set(fingerprintText(key.primary), { pub: key })
  for (const key of await loadRing(`${home}/secring.gpg`)) {
    const entry = keys.get(fingerprintText(key.primary)) ?? {}
    entry.sec = key
    entry.pub ??= key
    keys.set(fingerprintText(key.primary), entry)
  }
  return { home, keys }
}

/** Packets of a key, in order, from its parts: so that merging two copies of a key keeps their structure */
function rebuild(key) {
  const packets = []
  const keyBody = k => concat(k.body, k.secretBody ?? new Uint8Array())
  packets.push({ tag: key.secret ? TAG.SECRET_KEY : TAG.PUBLIC_KEY, body: key.secret ? keyBody(key.primary) : key.primary.body })
  for (const sig of key.sigs) packets.push({ tag: TAG.SIGNATURE, body: sig.body })
  for (const holder of key.uids) {
    packets.push({ tag: TAG.USER_ID, body: encoder.encode(holder.uid) })
    for (const sig of holder.sigs) packets.push({ tag: TAG.SIGNATURE, body: sig.body })
  }
  for (const holder of key.subkeys) {
    packets.push({ tag: holder.secret ? TAG.SECRET_SUBKEY : TAG.PUBLIC_SUBKEY, body: holder.secret ? keyBody(holder.key) : holder.key.body })
    for (const sig of holder.sigs) packets.push({ tag: TAG.SIGNATURE, body: sig.body })
  }
  return { ...key, packets }
}

const bodyKey = bytes => hex(bytes)

/** `a` with what `b` adds: user IDs, subkeys and signatures not already there; a secret part replaces a public one */
function merge(a, b) {
  const sigsUnion = (x, y) => { const seen = new Set(x.map(sig => bodyKey(sig.body))); return [...x, ...y.filter(sig => !seen.has(bodyKey(sig.body)))] }
  const out = { ...a, secret: a.secret || b.secret, primary: b.secret && !a.secret ? b.primary : a.primary, sigs: sigsUnion(a.sigs, b.sigs) }
  out.uids = a.uids.map(holder => ({ ...holder, sigs: sigsUnion(holder.sigs, b.uids.find(other => other.uid === holder.uid)?.sigs ?? []) }))
  for (const holder of b.uids) if (!out.uids.some(own => own.uid === holder.uid)) out.uids.push(holder)
  out.subkeys = a.subkeys.map(holder => {
    const other = b.subkeys.find(candidate => fingerprintText(candidate.key) === fingerprintText(holder.key))
    if (!other) return holder
    return { ...(other.secret && !holder.secret ? other : holder), sigs: sigsUnion(holder.sigs, other.sigs) }
  })
  for (const holder of b.subkeys) if (!out.subkeys.some(own => fingerprintText(own.key) === fingerprintText(holder.key))) out.subkeys.push(holder)
  return rebuild(out)
}

function saveKeyring(ring) {
  const pub = [], sec = []
  for (const { pub: p, sec: s } of ring.keys.values()) {
    if (p) pub.push(writeKey(s ? merge(p, s) : p, false))
    if (s) sec.push(writeKey(s, true))
  }
  writeFileAtomic(`${ring.home}/pubring.gpg`, concat(...pub), 0o644)
  writeFileAtomic(`${ring.home}/secring.gpg`, concat(...sec), 0o600)
}

function find(ring, spec, secret = false) {
  const found = [...ring.keys.values()].filter(entry => (secret ? entry.sec : entry.pub) && matches(entry.pub, spec))
  return found
}

const isoDate = seconds => { const d = new Date(seconds * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const longDate = seconds => new Date(seconds * 1000).toLocaleString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).replace(/,/g, '')

// Listing --------------------------------------------------------------------------------------------------------------

async function listKeys(ring, o, specs, secret, fingerprints) {
  const now = Math.floor(Date.now() / 1000)
  const entries = [...ring.keys.values()].filter(entry => (secret ? entry.sec : entry.pub) && (specs.length === 0 || specs.some(spec => matches(entry.pub, spec))))
  if (specs.length && entries.length === 0) { say(`error reading key: No ${secret ? 'secret ' : 'public '}key`); return 2 }
  const lines = []
  if (!o.colons && entries.length) lines.push(`${ring.home}/${secret ? 'secring' : 'pubring'}.gpg`, '-'.repeat(ring.home.length + 12))
  for (const entry of entries) {
    const key = secret ? merge(entry.pub, entry.sec) : entry.pub
    const v = await validate(key, now)
    const status = v.revoked ? ` [revoked]` : v.expires !== undefined ? ` [${v.expires <= now ? 'expired' : 'expires'}: ${isoDate(v.expires)}]` : ''
    const validity = entry.sec ? 'ultimate' : ' unknown'
    if (o.colons) {
      lines.push(`${secret ? 'sec' : 'pub'}:${entry.sec ? 'u' : '-'}:${key.primary.fields.bits ?? 255}:${key.primary.algo}:${keyidText(key.primary)}:${key.primary.created}:${v.expires ?? ''}::${entry.sec ? 'u' : '-'}:::${usageLetters(v.flags, true).toLowerCase()}${usageLetters(v.flags, true)}:`)
      lines.push(`fpr:::::::::${fingerprintText(key.primary)}:`)
      for (const uid of v.uids) lines.push(`uid:${entry.sec ? 'u' : '-'}::::${uid.sig.created}::${hex(new Uint8Array(await hash(2, encoder.encode(uid.uid)))).slice(0, 40)}::${uid.uid.replace(/:/g, '\\x3a')}::::::::::0:`)
      for (const sub of v.subkeys) {
        lines.push(`${secret ? 'ssb' : 'sub'}:${entry.sec ? 'u' : '-'}:${sub.key.fields.bits ?? 255}:${sub.key.algo}:${keyidText(sub.key)}:${sub.key.created}:${sub.expires ?? ''}:::::${usageLetters(sub.flags).toLowerCase()}:`)
        lines.push(`fpr:::::::::${fingerprintText(sub.key)}:`)
      }
      continue
    }
    const fpr = fingerprints ? fingerprintText(key.primary).match(/.{4}/g).join(' ').replace(/^((?:\S+ ){5})/, '$1 ') : fingerprintText(key.primary)
    lines.push(`${secret ? 'sec' : 'pub'}   ${algoName(key.primary)} ${isoDate(key.primary.created)} [${usageLetters(v.flags, true)}]${status}`, `      ${fpr}`)
    for (const uid of v.uids) lines.push(`uid           [${uid.revoked ? 'revoked' : v.expired ? 'expired' : validity}] ${uid.uid}`)
    for (const sub of v.subkeys) {
      const subStatus = sub.revoked ? ' [revoked]' : sub.expires !== undefined ? ` [${sub.expires <= now ? 'expired' : 'expires'}: ${isoDate(sub.expires)}]` : ''
      lines.push(`${secret ? 'ssb' : 'sub'}   ${algoName(sub.key)} ${isoDate(sub.key.created)} [${usageLetters(sub.flags)}]${subStatus}`)
      if (o.listSigs) for (const sig of sub.holder.sigs) lines.push(`sig          ${keyidText({ keyid: sig.issuer ?? new Uint8Array(8) })} ${isoDate(sig.created)}  [self-signature]`)
    }
    lines.push('')
  }
  writeAll(1, encoder.encode(lines.length ? lines.join('\n') + '\n' : ''))
  return 0
}

// Key generation -------------------------------------------------------------------------------------------------------

function expirySeconds(text, now) {
  if (text === undefined || text === '' || text === '-' || text === 'default') return 3 * 365 * 86400
  if (text === '0' || text === 'never' || text === 'none') return undefined
  const match = /^(\d+)([dwmy]?)$/.exec(text)
  if (match) return Number(match[1]) * { '': 86400, d: 86400, w: 604800, m: 2592000, y: 31536000 }[match[2]]
  const date = Date.parse(text)
  if (!Number.isNaN(date)) return Math.floor(date / 1000) - now
  throw new Fail(`invalid expiration date '${text}'`)
}

async function generate(ring, o, uid, algo, expire) {
  if (!uid || !uid.trim()) throw new Fail('Key generation failed: Invalid user ID')
  if ([...ring.keys.values()].some(entry => entry.pub.uids.some(holder => holder.uid === uid)) && !o.yes) {
    if (o.batch || !confirm(o, `A key for "${uid}" already exists\nCreate anyway?`)) throw new Fail('Key generation canceled.')
  }
  const passphrase = askPassphrase(o, `Please enter a passphrase to protect your new key`, true)
  if (!passphrase) say('the new key is not protected by a passphrase')
  const now = Math.floor(Date.now() / 1000)
  const key = await generateKey({ uid, algo, expireSeconds: expirySeconds(expire, now), passphrase, created: now })
  ring.keys.set(fingerprintText(key.primary), { pub: key, sec: key })
  saveKeyring(ring)
  say(`key ${keyidText(key.primary)} marked as ultimately trusted`)
  raw('public and secret key created and signed.\n\n')
  await listKeys(ring, { ...o, colons: false }, [fingerprintText(key.primary)], false, false).then(() => {})
  return 0
}

// Signing and verifying ------------------------------------------------------------------------------------------------

/** The key to sign with: `-u`'s, else the first secret key that can sign; with its secret unlocked */
async function signingKey(ring, o) {
  const candidates = o.localUser ? find(ring, o.localUser, true) : [...ring.keys.values()].filter(entry => entry.sec)
  for (const entry of candidates) {
    const key = merge(entry.pub, entry.sec)
    const v = await validate(key)
    if (v.revoked || v.expired) continue
    // a signing subkey if there is one, else the primary when it may sign
    const sub = v.subkeys.find(s => s.flags & 0x02 && !s.revoked && !(s.expires && s.expires <= Date.now() / 1000) && s.holder.secret)
    const signer = sub ? sub.key : key.primary
    if (!sub && v.flags !== undefined && !(v.flags & 0x02)) continue
    const uid = v.uids[0]?.uid ?? ''
    return { key: signer, secret: await unlockKey(o, signer, uid), uid }
  }
  throw new Fail(o.localUser ? `skipped "${o.localUser}": No secret key\ngpg: signing failed: No secret key` : 'no default secret key: No secret key\ngpg: signing failed: No secret key')
}

async function unlockKey(o, key, uid) {
  if (!isProtected(key)) return await unlock(key)
  for (let tries = 0; tries < 3; tries++) {
    const passphrase = askPassphrase(o, `Please enter the passphrase to unlock the OpenPGP secret key:\n"${uid}"\n${algoName(key).replace(/^rsa/, '')}${key.algo === ALGO.RSA ? '-bit RSA' : ''} key, ID ${keyidText(key)},\ncreated ${isoDate(key.created)}.\n`)
    try { return await unlock(key, passphrase) } catch (error) {
      if (!error.badPassphrase) throw error
      say('Bad passphrase')
      if (givenPassphrase(o) !== undefined) break
    }
  }
  throw new Fail('signing failed: Bad passphrase')
}

/** Looks a signer up by key ID among the public keys (primary and subkeys) */
function lookupSigner(ring) {
  return keyid => {
    for (const entry of ring.keys.values()) {
      const key = entry.sec ? merge(entry.pub, entry.sec) : entry.pub
      for (const candidate of [key.primary, ...key.subkeys.map(holder => holder.key)]) {
        if (hex(candidate.keyid) === hex(keyid)) return { signer: candidate, entry, key }
      }
    }
    return undefined
  }
}

async function reportSignature(ring, result) {
  const { sig } = result
  raw(`gpg: Signature made ${longDate(sig.created)}\n`)
  const algo = sig.algo === ALGO.EDDSA ? 'EDDSA' : 'RSA'
  raw(`gpg:                using ${algo} key ${sig.issuerFpr ? hex(sig.issuerFpr) : hex(sig.issuer ?? new Uint8Array())}\n`)
  if (result.status === 'nokey') { say(`Can't check signature: No public key`); return 2 }
  const v = await validate(result.key)
  const [first, ...others] = v.uids
  const trust = result.entry.sec ? 'ultimate' : 'unknown'
  if (result.status === 'bad') { say(`BAD signature from "${first?.uid ?? ''}" [${trust}]`); return 1 }
  say(`Good signature from "${first?.uid ?? ''}" [${trust}]`)
  for (const uid of others) raw(`gpg:                 aka "${uid.uid}" [${trust}]\n`)
  if (!result.entry.sec) {
    say('WARNING: This key is not certified with a trusted signature!')
    raw('gpg:          There is no indication that the signature belongs to the owner.\n')
    raw(`Primary key fingerprint: ${fingerprintText(result.key.primary).match(/.{4}/g).join(' ').replace(/^((?:\S+ ){5})/, '$1 ')}\n`)
  }
  return 0
}

async function verify(ring, o, files) {
  const lookup = lookupSigner(ring)
  const first = files[0] ?? '-'
  let input
  try { input = first === '-' ? readFdBytes(0) : readFileBytes(first) } catch (error) { throw new Fail(`can't open '${first}': ${reasonOf(error)}`) }
  let worst = 0
  const note = code => { worst = Math.max(worst, code) }
  // a cleartext signature
  if (isArmored(input) && /-----BEGIN PGP SIGNED MESSAGE-----/.test(decoder.decode(input.subarray(0, 4096)))) {
    const blocks = dearmor(decoder.decode(input))
    const cleartext = blocks.find(block => block.kind === 'SIGNED MESSAGE')
    const signatures = (await openMessage(blocks.find(block => block.kind === 'SIGNATURE').bytes)).signatures
    for (const sig of signatures) note(await reportSignature(ring, await checkSignature(sig, encoder.encode(cleartext.text), lookup, true)))
    return worst
  }
  const bytes = binaryOf(input)
  const message = await openMessage(bytes)
  if (message.literal) {
    for (const sig of message.signatures) note(await reportSignature(ring, await checkSignature(sig, message.literal.data, lookup)))
    if (!message.signatures.length) throw new Fail('no signature found')
    return worst
  }
  // a detached signature, and its data: the file named, or the signature's name without .sig or .asc
  const dataFile = files[1] ?? first.replace(/\.(sig|asc)$/, '')
  if (dataFile === first) throw new Fail('no signed data\ngpg: can\'t hash datafile: No data')
  let data
  try { data = dataFile === '-' ? readFdBytes(0) : readFileBytes(dataFile) } catch (error) { throw new Fail(`can't open signed data '${dataFile}'\ngpg: can't hash datafile: ${reasonOf(error)}`) }
  if (files.length < 2) raw(`gpg: assuming signed data in '${dataFile}'\n`)
  if (!message.signatures.length) throw new Fail('no signature found')
  for (const sig of message.signatures) note(await reportSignature(ring, await checkSignature(sig, data, lookup)))
  return worst
}

// Encryption -----------------------------------------------------------------------------------------------------------

async function recipientKey(ring, o, spec) {
  const found = find(ring, spec)
  if (!found.length) throw new Fail(`${spec}: skipped: No public key\ngpg: [stdin]: encryption failed: No public key`)
  const entry = found[0]
  const key = entry.sec ? merge(entry.pub, entry.sec) : entry.pub
  const v = await validate(key)
  if (v.revoked) throw new Fail(`${spec}: skipped: Unusable public key`)
  const now = Date.now() / 1000
  const sub = v.subkeys.filter(s => s.flags & 0x0c && !s.revoked && !(s.expires && s.expires <= now)).sort((a, b) => b.key.created - a.key.created)[0]
  const target = sub ? sub.key : key.primary.algo === ALGO.RSA && (v.flags === undefined || v.flags & 0x0c) ? key.primary : undefined
  if (!target) throw new Fail(`${spec}: skipped: Unusable public key`)
  if (!entry.sec && o.trustModel !== 'always') {
    raw(`${algoName(target)}/${keyidText(target)} ${isoDate(target.created)} ${v.uids[0]?.uid ?? ''}\n Primary key fingerprint: ${fingerprintText(key.primary).match(/.{4}/g).join(' ')}\n\nIt is NOT certain that the key belongs to the person named\nin the user ID.  If you *really* know what you are doing,\nyou may answer the next question with yes.\n\n`)
    if (o.batch || !/^y(es)?$/i.test(ask(o, 'Use this key anyway? (y/N) ').trim())) throw new Fail(`${spec}: There is no assurance this key belongs to the named user\ngpg: [stdin]: encryption failed: Unusable public key`)
  }
  return target
}

async function decrypt(ring, o, file) {
  let input
  try { input = file === '-' ? readFdBytes(0) : readFileBytes(file) } catch (error) { throw new Fail(`can't open '${file}': ${reasonOf(error)}`) }
  const message = await openMessage(binaryOf(input))
  if (!message.encrypted) {
    if (message.literal) {
      // a signed but not encrypted message: its data, and the signature checked
      output(o, message.literal.data)
      for (const sig of message.signatures) await reportSignature(ring, await checkSignature(sig, message.literal.data, lookupSigner(ring)))
      return 0
    }
    throw new Fail('no valid OpenPGP data found.\ngpg: decrypt_message failed: Unknown system error', 2)
  }
  let session
  const failures = []
  for (const body of message.encrypted.pkesk) {
    const keyid = hex(body.subarray(1, 9))
    const algo = body[9]
    let match
    for (const entry of ring.keys.values()) {
      if (!entry.sec) continue
      const key = merge(entry.pub, entry.sec)
      const holder = [{ key: key.primary, secret: true }, ...key.subkeys].find(h => h.secret && (hex(h.key.keyid) === keyid || keyid === '0000000000000000') && h.key.algo === algo)
      if (holder) { match = { key, sub: holder.key }; break }
    }
    const name = algo === ALGO.ECDH ? 'cv25519' : algo === ALGO.RSA ? 'rsa' : `algo ${algo}`
    if (!match) { failures.push(`encrypted with ${name} key, ID ${keyid}`); continue }
    const v = await validate(match.key)
    const uid = v.uids[0]?.uid ?? ''
    try {
      const secret = await unlockKey(o, match.sub, uid)
      session = await sessionFromPkesk(body, match.sub, secret)
      raw(`gpg: encrypted with ${algoName(match.sub)} key, ID ${keyidText(match.sub)}, created ${isoDate(match.sub.created)}\n      "${uid}"\n`)
      break
    } catch (error) {
      if (error instanceof Fail) throw new Fail(error.message.replace('signing failed', 'public key decryption failed'))
      failures.push(`public key decryption failed: ${error.message}`)
    }
  }
  if (!session && message.encrypted.skesk.length) {
    for (const body of message.encrypted.skesk) {
      raw(`gpg: ${cipherName(body[1])}.CFB encrypted data\n`)
      const passphrase = askPassphrase(o, 'Enter passphrase')
      try {
        const candidate = await sessionFromSkesk(body, passphrase)
        // a wrong passphrase shows when the data does not decrypt
        await decryptData(message.encrypted.data, candidate)
        session = candidate
        raw(`gpg: encrypted with 1 passphrase\n`)
        break
      } catch (error) { failures.push(error.badKey ? 'decryption failed: Bad session key' : error.message) }
    }
  }
  if (!session) {
    for (const failure of failures) say(failure)
    throw new Fail(message.encrypted.pkesk.length && !message.encrypted.skesk.length ? 'decryption failed: No secret key' : failures.at(-1) ?? 'decryption failed: No secret key')
  }
  let plain
  try { plain = await decryptData(message.encrypted.data, session) } catch (error) { throw new Fail(error.manipulated ? 'WARNING: message was manipulated!\ngpg: decryption failed: Bad session key' : `decryption failed: ${error.message}`) }
  const inner = await openMessage(plain)
  if (!inner.literal) throw new Fail('decryption failed: no data in the message')
  output(o, inner.literal.data)
  let status = 0
  for (const sig of inner.signatures) status = Math.max(status, await reportSignature(ring, await checkSignature(sig, inner.literal.data, lookupSigner(ring))))
  return status
}

// Output ---------------------------------------------------------------------------------------------------------------

function output(o, bytes) {
  const path = o.output
  if (path === undefined || path === '-') { writeAll(1, bytes); return }
  if (exists(path) && !o.yes) {
    if (o.batch || !/^y(es)?$/i.test(ask(o, `File '${path}' exists. Overwrite? (y/N) `).trim())) throw new Fail(`signing failed: File exists`)
  }
  writeFileAtomic(path, bytes, 0o644)
}

/** Where a command writes when no -o is given and its input was a file: FILE.gpg, FILE.asc, FILE.sig */
function defaultOutput(o, file, suffix) {
  if (o.output !== undefined || file === undefined || file === '-') return
  o.output = `${file}.${o.armor ? 'asc' : suffix}`
}

function readInput(file) {
  try { return file === undefined || file === '-' ? readFdBytes(0) : readFileBytes(file) } catch (error) { throw new Fail(`can't open '${file}': ${reasonOf(error)}`) }
}

const armored = (o, kind, bytes) => (o.armor ? encoder.encode(armor(kind, bytes)) : bytes)

// Main -----------------------------------------------------------------------------------------------------------------

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'sbecdkKar:u:o:tvqhn',
    long: {
      sign: 's', 'clear-sign': 'clearsign', clearsign: 'clearsign', 'detach-sign': 'b', encrypt: 'e', symmetric: 'c', decrypt: 'd', verify: 'verify',
      'list-keys': 'k', 'list-public-keys': 'k', 'list-signatures': 'listsigs', 'list-sigs': 'listsigs', 'check-signatures': 'listsigs', 'check-sigs': 'listsigs', fingerprint: 'fingerprint',
      'list-secret-keys': 'K', 'quick-generate-key': 'quickgen', 'quick-gen-key': 'quickgen', 'generate-key': 'gen', 'gen-key': 'gen', 'full-generate-key': 'gen', 'full-gen-key': 'gen',
      'delete-keys': 'delete', 'delete-key': 'delete', 'delete-secret-keys': 'deletesecret', 'delete-secret-key': 'deletesecret', 'delete-secret-and-public-keys': 'deleteboth', 'delete-secret-and-public-key': 'deleteboth',
      export: 'export', 'export-secret-keys': 'exportsecret', import: 'import', enarmor: 'enarmor', dearmor: 'dearmor', 'print-md': { key: 'printmd', arg: 'required' }, 'gen-random': 'genrandom',
      armor: 'a', recipient: { key: 'r', arg: 'required' }, 'local-user': { key: 'u', arg: 'required' }, output: { key: 'o', arg: 'required' }, textmode: 't', homedir: { key: 'homedir', arg: 'required' },
      batch: 'batch', yes: 'yes', 'no-tty': 'notty', passphrase: { key: 'passphrase', arg: 'required' }, 'passphrase-file': { key: 'passphrasefile', arg: 'required' }, 'passphrase-fd': { key: 'passphrasefd', arg: 'required' },
      'pinentry-mode': { key: 'pinentry', arg: 'required' }, 'trust-model': { key: 'trust', arg: 'required' }, 'always-trust': 'alwaystrust', 'digest-algo': { key: 'digest', arg: 'required' },
      'personal-digest-preferences': { key: 'digest', arg: 'required' }, 'with-colons': 'colons', 'with-fingerprint': 'withfpr', verbose: 'v', quiet: 'q', help: 'h', version: 'version', 'dry-run': 'n',
      'keyid-format': { key: 'keyidformat', arg: 'required' }, 'default-key': { key: 'u', arg: 'required' }, 'cipher-algo': { key: 'cipher', arg: 'required' }, 'no-default-keyring': 'nodefault', keyring: { key: 'keyring', arg: 'required' },
      's2k-mode': { key: 'ignore', arg: 'required' }, 's2k-count': { key: 'ignore', arg: 'required' }, 'compress-algo': { key: 'ignore', arg: 'required' }, 'no-armor': 'noarmor', 'list-only': 'listonly', 'keyserver': { key: 'keyserver', arg: 'required' },
      'recv-keys': 'recv', 'send-keys': 'send', 'search-keys': 'recv', 'gen-revoke': 'unsupported', 'edit-key': 'unsupported', 'sign-key': 'unsupported', 'lsign-key': 'unsupported', 'quick-sign-key': 'unsupported', 'quick-add-uid': 'unsupported', 'quick-add-key': 'unsupported'
    }
  })
  if (error) { say(error); return 2 }
  const o = { recipients: [], armor: false, batch: false, yes: false, text: false, colons: false, hashAlgo: 10, cipher: 9 }
  const commands = []
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') {
      writeAll(1, encoder.encode(`gpg (ecmaOS OpenPGP) 1.0\nHome: ${homeDir(o)}\nSupported algorithms:\nPubkey: RSA, EDDSA, ECDH\nCipher: AES, AES192, AES256\nHash: SHA1, SHA224, SHA256, SHA384, SHA512\nCompression: Uncompressed, ZIP, ZLIB (reading)\n`))
      return 0
    }
    if (['s', 'clearsign', 'b', 'e', 'c', 'd', 'verify', 'k', 'listsigs', 'fingerprint', 'K', 'quickgen', 'gen', 'delete', 'deletesecret', 'deleteboth', 'export', 'exportsecret', 'import', 'enarmor', 'dearmor', 'printmd', 'genrandom', 'recv', 'send', 'unsupported'].includes(key)) {
      commands.push(key)
      if (key === 'printmd') o.printmd = value
      if (key === 'unsupported') o.unsupported = argv.slice(1).find(arg => /^--(gen-revoke|edit-key|sign-key|lsign-key|quick-sign-key|quick-add-uid|quick-add-key)$/.test(arg))
    } else if (key === 'a') o.armor = true
    else if (key === 'noarmor') o.armor = false
    else if (key === 'r') o.recipients.push(value)
    else if (key === 'u') o.localUser = value
    else if (key === 'o') o.output = value
    else if (key === 't') o.text = true
    else if (key === 'homedir') o.homedir = value
    else if (key === 'batch' || key === 'notty') o.batch = true
    else if (key === 'yes') o.yes = true
    else if (key === 'passphrase') o.passphrase = value
    else if (key === 'passphrasefile') o.passphraseFile = value
    else if (key === 'passphrasefd') o.passphraseFd = Number(value)
    else if (key === 'trust') o.trustModel = value
    else if (key === 'alwaystrust') o.trustModel = 'always'
    else if (key === 'colons') o.colons = true
    else if (key === 'digest') {
      const id = HASH_IDS[value.toUpperCase().split(/\s+/)[0].replace('-', '')]
      if (!id) { say(`invalid digest algorithm '${value}'`); return 2 }
      o.hashAlgo = id
    } else if (key === 'cipher') {
      const id = { AES: 7, AES128: 7, AES192: 8, AES256: 9 }[value.toUpperCase()]
      if (!id) { say(`invalid cipher algorithm '${value}'`); return 2 }
      o.cipher = id
    } else if (key === 'keyring' || key === 'nodefault') { say('other keyrings than pubring.gpg are not supported; use --homedir'); return 2 }
  }

  // -s with -e is a signed and encrypted message; anything else is one command
  const command = commands.includes('e') && commands.includes('s') ? 'se' : commands.includes('c') && commands.includes('s') ? 'sc' : commands[0] ?? 'default'
  if (command === 'unsupported') { say(`${o.unsupported}: not supported here: there is no web of trust, revocation or key editing`); return 2 }
  if (command === 'recv' || command === 'send') { say('keyserver receive failed: No keyserver available: there are no key servers to reach from here; use --import and --export'); return 2 }

  if (command === 'genrandom') {
    const count = Number(operands[1] ?? 0)
    const bytes = random(count)
    writeAll(1, o.armor ? encoder.encode(btoa(String.fromCharCode(...bytes)) + '\n') : bytes)
    return 0
  }
  if (command === 'enarmor') { writeAll(1, encoder.encode(armor('ARMORED FILE', readInput(operands[0]), { Comment: 'Use "gpg --dearmor" for unpacking' }))); return 0 }
  if (command === 'dearmor') { output(o, binaryOf(readInput(operands[0]))); return 0 }
  if (command === 'printmd') {
    const id = HASH_IDS[o.printmd.toUpperCase().replace('-', '')]
    if (!id) { say(`invalid hash algorithm '${o.printmd}'`); return 2 }
    for (const file of operands.length ? operands : ['-']) {
      const digest = hex(await hash(id, readInput(file)))
      writeAll(1, encoder.encode(`${file === '-' ? '' : `${file}: `}${digest.match(/.{1,8}/g).join(' ')}\n`))
    }
    return 0
  }

  ensureHome(o)
  const ring = await loadKeyring(o)

  switch (command) {
    case 'k': case 'listsigs': return await listKeys(ring, { ...o, listSigs: command === 'listsigs' }, operands, false, false)
    case 'fingerprint': return await listKeys(ring, o, operands, false, true)
    case 'K': return await listKeys(ring, o, operands, true, false)
    case 'quickgen': return await generate(ring, o, operands[0], operands[1] ?? 'default', operands[3])
    case 'gen': {
      const name = ask(o, 'Real name: ').trim()
      const email = ask(o, 'Email address: ').trim()
      const uid = email ? `${name}${name ? ' ' : ''}<${email}>` : name
      raw(`You selected this USER-ID:\n    "${uid}"\n\n`)
      if (!/^o/i.test(ask(o, 'Change (N)ame, (E)mail, or (O)kay/(Q)uit? ').trim())) throw new Fail('Key generation canceled.')
      return await generate(ring, o, uid, 'default', undefined)
    }
    case 'import': {
      let processed = 0, imported = 0, unchanged = 0, secrets = 0
      for (const file of operands.length ? operands : ['-']) {
        const keys = await readKeys(binaryOf(readInput(file)))
        if (!keys.length) { say('no valid OpenPGP data found.'); continue }
        for (const key of keys) {
          processed++
          const id = fingerprintText(key.primary)
          const v = await validate(key)
          if (!v.uids.length) { say(`key ${keyidText(key.primary)}: no valid user IDs`); continue }
          const name = v.uids[0].uid
          const entry = ring.keys.get(id)
          if (!entry) {
            ring.keys.set(id, key.secret ? { pub: key, sec: key } : { pub: key })
            imported++
            say(`key ${keyidText(key.primary)}: public key "${name}" imported`)
          } else {
            const before = writeKey(entry.pub, false).length
            entry.pub = merge(entry.pub, key)
            if (key.secret) entry.sec = entry.sec ? merge(entry.sec, key) : merge(key, key)
            if (writeKey(entry.pub, false).length === before && !key.secret) { unchanged++; say(`key ${keyidText(key.primary)}: "${name}" not changed`) }
            else if (!key.secret) say(`key ${keyidText(key.primary)}: "${name}" updated`)
          }
          if (key.secret) { secrets++; say(`key ${keyidText(key.primary)}: secret key imported`) }
        }
      }
      saveKeyring(ring)
      say(`Total number processed: ${processed}`)
      if (imported) say(`              imported: ${imported}`)
      if (unchanged) say(`             unchanged: ${unchanged}`)
      if (secrets) { say(`       secret keys read: ${secrets}`); say(`   secret keys imported: ${secrets}`) }
      return 0
    }
    case 'export': case 'exportsecret': {
      const secret = command === 'exportsecret'
      const entries = [...ring.keys.values()].filter(entry => (secret ? entry.sec : entry.pub) && (operands.length === 0 || operands.some(spec => matches(entry.pub, spec))))
      if (!entries.length) { say('WARNING: nothing exported'); return 0 }
      const bytes = concat(...entries.map(entry => writeKey(secret ? entry.sec : entry.sec ? merge(entry.pub, entry.sec) : entry.pub, secret)))
      output(o, o.armor ? encoder.encode(armor(secret ? 'PRIVATE KEY BLOCK' : 'PUBLIC KEY BLOCK', bytes)) : bytes)
      return 0
    }
    case 'delete': case 'deletesecret': case 'deleteboth': {
      if (!operands.length) throw new Fail('Note: No key.  Try --list-keys')
      let status = 0
      for (const spec of operands) {
        const found = find(ring, spec, command === 'deletesecret')
        if (!found.length) { say(`key "${spec}" not found: No public key`); status = 2; continue }
        const entry = found[0]
        const id = fingerprintText(entry.pub.primary)
        if (command === 'delete' && entry.sec) {
          say(`there is a secret key for public key "${spec}"!`)
          say('use option "--delete-secret-keys" to delete it first.')
          status = 2
          continue
        }
        const v = await validate(entry.pub)
        raw(`\n${command === 'delete' ? 'pub' : 'sec'}  ${algoName(entry.pub.primary)}/${keyidText(entry.pub.primary)} ${isoDate(entry.pub.primary.created)} ${v.uids[0]?.uid ?? ''}\n\n`)
        if (!(o.batch && o.yes) && !confirm(o, `Delete this key from the keyring?`)) continue
        if (command === 'delete' || command === 'deleteboth') ring.keys.delete(id)
        else delete entry.sec
      }
      saveKeyring(ring)
      return status
    }
    case 'verify': return await verify(ring, o, operands)
    case 'd': return await decrypt(ring, o, operands[0] ?? '-')
    case 's': case 'clearsign': case 'b': {
      const signer = await signingKey(ring, o)
      const data = readInput(operands[0])
      if (command === 'clearsign') {
        defaultOutput({ ...o, armor: true }, operands[0], 'asc')
        if (o.output === undefined && operands[0] && operands[0] !== '-') o.output = `${operands[0]}.asc`
        const { header, signature } = await signClear({ ...signer, text: decoder.decode(data), hashAlgo: o.hashAlgo })
        output(o, encoder.encode(header + armor('SIGNATURE', signature)))
        return 0
      }
      if (command === 'b') {
        defaultOutput(o, operands[0], 'sig')
        output(o, armored(o, 'SIGNATURE', await signDetached({ ...signer, data, text: o.text, hashAlgo: o.hashAlgo })))
        return 0
      }
      defaultOutput(o, operands[0], 'gpg')
      const name = operands[0] && operands[0] !== '-' ? operands[0].slice(operands[0].lastIndexOf('/') + 1) : ''
      output(o, armored(o, 'MESSAGE', await signInline({ ...signer, data, name, text: o.text, hashAlgo: o.hashAlgo })))
      return 0
    }
    case 'e': case 'c': case 'se': case 'sc': {
      const data = readInput(operands[0])
      const name = operands[0] && operands[0] !== '-' ? operands[0].slice(operands[0].lastIndexOf('/') + 1) : ''
      if ((command === 'e' || command === 'se') && !o.recipients.length) {
        // with no -r, GnuPG asks; here the user names one
        const spec = o.batch ? '' : ask(o, 'You did not specify a user ID. (you may use "-r")\n\nCurrent recipients:\n\nEnter the user ID.  End with an empty line: ').trim()
        if (!spec) throw new Fail('no valid addressees\ngpg: [stdin]: encryption failed: No user ID')
        o.recipients.push(spec)
      }
      const recipients = []
      for (const spec of o.recipients) recipients.push(await recipientKey(ring, o, spec))
      let plaintext = literal(data, { name, format: o.text ? 't' : 'b' })
      if (command === 'se' || command === 'sc') {
        const signer = await signingKey(ring, o)
        plaintext = await signInline({ ...signer, data, name, text: o.text, hashAlgo: o.hashAlgo })
      }
      const passphrase = command === 'c' || command === 'sc' ? askPassphrase(o, 'Enter passphrase', true) : undefined
      defaultOutput(o, operands[0], 'gpg')
      output(o, armored(o, 'MESSAGE', await encrypt({ recipients, passphrase, plaintext, cipher: o.cipher })))
      return 0
    }
    case 'default': {
      // as GnuPG does with no command: decrypt what is encrypted, check what is signed, list what is a key
      const file = operands[0] ?? '-'
      const input = readInput(file)
      const bytes = binaryOf(input)
      const keys = await readKeys(bytes).catch(() => [])
      if (keys.length) {
        say('WARNING: no command supplied.  Trying to guess what you mean ...')
        for (const key of keys) {
          const v = await validate(key)
          writeAll(1, encoder.encode(`${key.secret ? 'sec' : 'pub'}   ${algoName(key.primary)} ${isoDate(key.primary.created)} [${usageLetters(v.flags, true)}]\n      ${fingerprintText(key.primary)}\n${v.uids.map(uid => `uid           ${uid.uid}\n`).join('')}${v.subkeys.map(sub => `sub   ${algoName(sub.key)} ${isoDate(sub.key.created)} [${usageLetters(sub.flags)}]\n`).join('')}\n`))
        }
        return 0
      }
      const message = await openMessage(bytes)
      if (message.encrypted || message.literal) {
        if (file !== '-' && o.output === undefined && /\.(gpg|pgp|asc)$/.test(file)) o.output = file.replace(/\.(gpg|pgp|asc)$/, '')
        const temporary = `${homeDir(o)}/.input${Math.random().toString(36).slice(2, 8)}`
        writeFileAtomic(temporary, input)
        try { return await decrypt(ring, o, temporary) } finally { try { sys.unlink(temporary) } catch { /* gone */ } }
      }
      return await verify(ring, o, operands)
    }
  }
  return 0
}

try {
  exit(await main())
} catch (error) {
  if (error instanceof Fail) { say(error.message); exit(error.code) }
  say(reasonOf(error))
  exit(2)
}

