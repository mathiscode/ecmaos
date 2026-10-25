/**
 * Sign a kernel module, or make the key to sign with: `sign-module -k KEY [-s SIGNER] [-o OUT] FILE` and
 * `sign-module --genkey NAME`. The signature is Ed25519 over every byte before the trailer, which is appended to the file
 * as a comment block, so `modinfo` and `insmod` check it without running the module.
 */

import { getopt } from './lib/getopt.mjs'
import { die, help } from './lib/module-call.mjs'
import { resolvePath } from './lib/paths.mjs'

const { argv, exit, write, open, read, close, writeAll, getcwd, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const usage = `Usage: sign-module -k KEY [-s SIGNER] [-o OUT] FILE
       sign-module --genkey NAME
Sign the kernel module in FILE with the private key in KEY (made by --genkey), appending the signature to FILE or to OUT.
--genkey writes NAME.key (private, mode 600) and NAME.pub (public) in the current directory; copy NAME.pub to
/etc/modules-keys to make the kernel trust it.

  -k, --key KEY       the private key file
  -s, --signer NAME   the signer name in the trailer (default: the key file's name)
  -o, --output OUT    write the signed module here instead of over FILE
  -g, --genkey NAME   make a key pair
  --help              display this help and exit`

const base64 = bytes => btoa(String.fromCharCode(...bytes))
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
const toHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
const absolute = target => resolvePath(getcwd(), target)

function readText(path) {
  const fd = open(path, O_RDONLY)
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
    }
  } finally {
    close(fd)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return decoder.decode(bytes)
}

function writeText(path, text, mode) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode)
  try {
    writeAll(fd, encoder.encode(text))
  } finally {
    close(fd)
  }
}

/** The short id of a public key, the same one the kernel works out: the first 8 bytes of its SHA-256, in hex */
async function keyId(pub) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', pub)).subarray(0, 8))
}

async function genkey(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return die('sign-module', `bad key name '${name}'`)
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  writeText(absolute(`${name}.key`), JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }) + '\n', 0o600)
  writeText(absolute(`${name}.pub`), `# ecmaos module key ${name} (${await keyId(pub)})\n${base64(pub)}\n`, 0o644)
  write(1, encoder.encode(`${name}.key and ${name}.pub written; key id ${await keyId(pub)}\n`))
  return 0
}

async function sign(file, keyPath, signer, output) {
  const jwk = JSON.parse(readText(absolute(keyPath)))
  const key = await crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign'])
  // a module signed before is signed again from its bytes without the old trailer
  let body = readText(absolute(file)).replace(/\/\* ecmaos-module-signature\b[\s\S]*?\*\/\s*$/, '')
  if (!body.endsWith('\n')) body += '\n'
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(body)))
  const id = await keyId(fromBase64Url(jwk.x))
  const name = signer ?? keyPath.split('/').pop().replace(/\.key$/, '')
  writeText(absolute(output ?? file), `${body}/* ecmaos-module-signature\n * signer=${name}\n * key_id=${id}\n * sig=${base64(sig)}\n */\n`, 0o644)
  return 0
}

try {
  const parsed = getopt(argv.slice(1), { values: 'ksog', long: { key: 'k', signer: 's', output: 'o', genkey: 'g' } })
  if (parsed.error) exit(die('sign-module', parsed.error))
  const { opts, rest } = parsed
  if (opts.help) exit(help(usage))
  if (opts.g) exit(rest.length ? die('sign-module', 'extra operand with --genkey') : await genkey(opts.g))
  if (!opts.k) exit(die('sign-module', 'missing -k KEY'))
  if (rest.length !== 1) exit(die('sign-module', rest.length ? 'only one module file at a time' : 'missing module file'))
  exit(await sign(rest[0], opts.k, opts.s, opts.o))
} catch (error) {
  exit(die('sign-module', error instanceof Error ? error.message : String(error)))
}
