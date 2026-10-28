/**
 * `ssh-keygen`: make an ed25519, RSA or ECDSA key pair in OpenSSH's format (WebCrypto does the work), print the public half
 * of a private key (`-y`), or show a key's fingerprint (`-l`). There is no passphrase: a key is written unencrypted, and asking
 * for a passphrase is refused rather than ignored. Nothing is asked; the file defaults to `~/.ssh/id_TYPE`.
 */

import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { resolve } from './lib/path-utils.mjs'
import { bitsOf, fingerprint, generate, labelOf, parsePrivate, parsePublic, privateFile, publicLine } from './lib/openssh-keys.mjs'

const { argv, exit, writeAll, getcwd, env, mkdir, open, write, close, stat, read, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `usage: ssh-keygen [-q] [-b bits] [-C comment] [-f output_keyfile] [-N new_passphrase] [-t type]
       ssh-keygen -y -f input_keyfile
       ssh-keygen -l -f input_keyfile

Types: ed25519 (the default), rsa (3072 bits unless -b), ecdsa (256, 384 or 521 bits).
Keys are not encrypted: -N takes only the empty string. The file defaults to ~/.ssh/id_TYPE.`

const exists = path => { try { stat(path); return true } catch { return false } }

/** One line from standard input, or null at the end of it */
function readLine() {
  const bytes = []
  const one = new Uint8Array(1)
  for (;;) {
    if (read(0, one, -1) <= 0) return bytes.length ? new TextDecoder().decode(Uint8Array.from(bytes)) : null
    if (one[0] === 10) return new TextDecoder().decode(Uint8Array.from(bytes))
    bytes.push(one[0])
  }
}

function writeFile(path, text, mode) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode)
  try { const bytes = encoder.encode(text); for (let at = 0; at < bytes.length;) at += write(fd, bytes.subarray(at), -1) } finally { close(fd) }
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'qb:C:f:N:t:ylh' })
  if (error) { err(`ssh-keygen: ${error}`); err(usage); return 1 }
  if (operands.length) { err(usage); return 1 }
  const o = { quiet: false, type: 'ed25519', bits: undefined, comment: undefined, file: undefined, pass: '', show: false, finger: false }
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'q') o.quiet = true
    else if (key === 'b') { if (!/^\d+$/.test(value)) { err(`Bits has bad value ${value}`); return 255 } o.bits = Number(value) }
    else if (key === 'C') o.comment = value
    else if (key === 'f') o.file = value
    else if (key === 'N') o.pass = value
    else if (key === 't') o.type = value
    else if (key === 'y') o.show = true
    else if (key === 'l') o.finger = true
  }
  if (o.pass !== '') { err('ssh-keygen: passphrases are not supported here: keys are written without one (omit -N, or use -N "")'); return 1 }

  if (o.show || o.finger) {
    if (!o.file) { err('ssh-keygen: -f is required here'); return 1 }
    const path = resolve(getcwd(), o.file)
    let content
    try { content = readTextFile(path) } catch (e) { err(`${o.file}: ${reasonOf(e)}`); return 255 }
    let parsed
    try { parsed = content.includes('PRIVATE KEY') ? parsePrivate(content) : parsePublic(content.split('\n').find(line => line.trim() && !line.startsWith('#')) ?? '') } catch (e) {
      err(e.message === 'passphrase' ? `${o.file}: this key has a passphrase, which is not supported here` : `${o.file} is not a public key file.`)
      return 255
    }
    if (o.show) out(publicLine(parsed.key, parsed.comment) + '\n')
    else out(`${bitsOf(parsed.key)} ${await fingerprint(parsed.key)}${parsed.comment ? ` ${parsed.comment}` : ''} (${labelOf(parsed.key)})\n`)
    return 0
  }

  const kind = { ed25519: 'ed25519', rsa: 'rsa', ecdsa: 'ecdsa' }[o.type]
  if (!kind) { err(`unknown key type ${o.type}`); return 1 }
  const home = env.HOME || '/'
  const file = resolve(getcwd(), o.file ?? `${home}/.ssh/id_${kind}`)
  if (!o.quiet) out(`Generating public/private ${kind} key pair.\n`)
  if (exists(file)) {
    out(`${file} already exists.\nOverwrite (y/n)? `)
    const answer = (readLine() ?? '').trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') { out('\n'); return 1 }
  }
  const directory = file.slice(0, file.lastIndexOf('/')) || '/'
  if (!exists(directory)) {
    let made = ''
    for (const part of directory.split('/').filter(Boolean)) {
      made += `/${part}`
      try { mkdir(made, 0o700) } catch { /* it exists */ }
    }
  }
  let key
  try { key = await generate(kind, o.bits) } catch (e) { err(`ssh-keygen: ${e.message}`); return 1 }
  let hostname = 'localhost'
  try { hostname = readTextFile('/etc/hostname').trim() || hostname } catch { /* the default stands */ }
  const comment = o.comment ?? `${env.USER || env.LOGNAME || 'root'}@${hostname}`
  try {
    writeFile(file, privateFile(key, comment), 0o600)
    writeFile(`${file}.pub`, publicLine(key, comment) + '\n', 0o644)
  } catch (e) { err(`Saving key "${file}" failed: ${reasonOf(e)}`); return 255 }
  if (!o.quiet) {
    out(`Your identification has been saved in ${file}\nYour public key has been saved in ${file}.pub\nThe key fingerprint is:\n${await fingerprint(key)} ${comment}\n`)
  }
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`ssh-keygen: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
