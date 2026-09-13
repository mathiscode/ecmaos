/**
 * Real `execve`'d `crypto` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/crypto.ts`) per `feat/1.0.0-execve-commands`. `crypto.subtle`/
 * `crypto.getRandomValues` are standard Worker globals, identical to main-thread. `chalk` (ANSI
 * coloring) is dropped, matching `ls.mjs`'s precedent.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const SUPPORTED_SYMMETRIC_ALGORITHMS = {
  'aes-gcm': 'AES-GCM', 'aes-cbc': 'AES-CBC', 'aes-ctr': 'AES-CTR', 'aes-kw': 'AES-KW'
}

const SUPPORTED_ASYMMETRIC_ALGORITHMS = {
  'rsa-oaep': 'RSA-OAEP', 'rsa-pss': 'RSA-PSS',
  'rsassa-pkcs1-v1_5': 'RSASSA-PKCS1-v1_5', 'rsassa-pkcs1-v1-5': 'RSASSA-PKCS1-v1_5',
  'ecdsa': 'ECDSA', 'ecdh': 'ECDH'
}

const SUPPORTED_SIGN_ALGORITHMS = {
  'ecdsa': 'ECDSA', 'rsa-pss': 'RSA-PSS',
  'rsassa-pkcs1-v1_5': 'RSASSA-PKCS1-v1_5', 'rsassa-pkcs1-v1-5': 'RSASSA-PKCS1-v1_5', 'hmac': 'HMAC'
}

const SUPPORTED_DERIVE_ALGORITHMS = { 'pbkdf2': 'PBKDF2', 'hkdf': 'HKDF', 'ecdh': 'ECDH' }

const SUPPORTED_HASH_ALGORITHMS = {
  'sha1': 'SHA-1', 'sha-1': 'SHA-1', 'sha256': 'SHA-256', 'sha-256': 'SHA-256',
  'sha384': 'SHA-384', 'sha-384': 'SHA-384', 'sha512': 'SHA-512', 'sha-512': 'SHA-512'
}

const SUPPORTED_NAMED_CURVES = {
  'p-256': 'P-256', 'p256': 'P-256', 'p-384': 'P-384', 'p384': 'P-384', 'p-521': 'P-521', 'p521': 'P-521'
}

const SUPPORTED_KEY_FORMATS = { 'jwk': 'jwk', 'raw': 'raw', 'pkcs8': 'pkcs8', 'spki': 'spki' }

const usage = `Usage: crypto <subcommand> [options]

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
  crypto export --format pkcs8 --input key.pem --output key.json`

function readWholeFile(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return bytes
}

function writeWholeFile(fullPath, bytes) {
  const fd = open(fullPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    writeAll(fd, bytes)
  } finally {
    close(fd)
  }
}

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function toArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer
  const view = new Uint8Array(buffer)
  const newBuffer = new ArrayBuffer(view.length)
  new Uint8Array(newBuffer).set(view)
  return newBuffer
}

function writeOutput(cwd, output, outputData) {
  if (output) {
    writeWholeFile(resolve(cwd, output), outputData)
  } else {
    writeAll(1, outputData)
  }
}

function parseArgs(args) {
  const parsed = {}
  let i = 0

  while (i < args.length) {
    const arg = args[i]
    if (!arg) { i++; continue }

    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      i++
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (arg.includes('=')) {
        const parts = arg.split('=')
        const k = parts[0].slice(2)
        const v = parts.slice(1).join('=')
        if (k && v) parsed[k] = v
        i++
      } else if (i + 1 < args.length && !args[i + 1]?.startsWith('--')) {
        const nextArg = args[i + 1]
        if (nextArg) parsed[key] = nextArg
        i += 2
      } else {
        parsed[key] = true
        i++
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1)
      if (i + 1 < args.length && !args[i + 1]?.startsWith('-')) {
        const nextArg = args[i + 1]
        if (nextArg) parsed[key] = nextArg
        i += 2
      } else {
        parsed[key] = true
        i++
      }
    } else {
      if (!parsed._) parsed._ = []
      parsed._.push(arg)
      i++
    }
  }

  return parsed
}

async function handleGenerate(cwd, args) {
  const helpText = `Usage: crypto generate [OPTIONS]

Generate cryptographic keys.

Options:
  --algorithm, -a ALGORITHM    Algorithm (AES-GCM, AES-CBC, AES-CTR, AES-KW, RSA-OAEP, RSA-PSS, RSASSA-PKCS1-v1_5, ECDSA, ECDH, HMAC)
  --length, -l LENGTH          Key length in bits (for AES: 128, 192, 256; for RSA: 1024, 2048, 4096)
  --named-curve, -c CURVE      Named curve for ECDSA/ECDH (P-256, P-384, P-521)
  --hash, -h ALGORITHM         Hash algorithm for HMAC/RSA (SHA-1, SHA-256, SHA-384, SHA-512)
  --output, -o FILE             Output file (default: stdout, JWK format)
  --format, -f FORMAT           Output format (jwk, raw, pkcs8, spki) (default: jwk)
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const algorithm = parsed.algorithm || parsed.a
  const length = parsed.length || parsed.l
  const namedCurve = parsed['named-curve'] || parsed.c
  const hash = parsed.hash || parsed.h
  const output = parsed.output || parsed.o
  const formatValue = parsed.format || parsed.f || 'jwk'
  const format = (typeof formatValue === 'string' ? formatValue : 'jwk').toLowerCase()

  if (!algorithm || typeof algorithm !== 'string') {
    writeAll(2, new TextEncoder().encode('crypto generate: --algorithm is required\nTry "crypto generate --help" for more information.\n'))
    return 1
  }

  const algoLower = algorithm.toLowerCase()
  const keyFormat = SUPPORTED_KEY_FORMATS[format]
  if (!keyFormat) {
    writeAll(2, new TextEncoder().encode(`crypto generate: unsupported format '${format}'\n`))
    return 1
  }

  try {
    let key
    let exportFormat = keyFormat

    if (SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]) {
      const symAlgo = SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]
      const keyLength = length ? parseInt(length, 10) : 256

      if (![128, 192, 256].includes(keyLength)) {
        writeAll(2, new TextEncoder().encode('crypto generate: AES key length must be 128, 192, or 256\n'))
        return 1
      }

      key = await crypto.subtle.generateKey({ name: symAlgo, length: keyLength }, true, ['encrypt', 'decrypt'])

      if (keyFormat === 'pkcs8' || keyFormat === 'spki') {
        writeAll(2, new TextEncoder().encode('crypto generate: symmetric keys cannot be exported in PKCS8 or SPKI format\n'))
        return 1
      }
      exportFormat = keyFormat === 'raw' ? 'raw' : 'jwk'
    } else if (SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower] === 'ECDSA' || SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower] === 'ECDH') {
      const curve = namedCurve ? (SUPPORTED_NAMED_CURVES[namedCurve.toLowerCase()] || 'P-256') : 'P-256'
      const keyUsages = SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower] === 'ECDSA' ? ['sign', 'verify'] : ['deriveKey', 'deriveBits']

      key = await crypto.subtle.generateKey({ name: SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower], namedCurve: curve }, true, keyUsages)

      if (keyFormat === 'raw') {
        writeAll(2, new TextEncoder().encode('crypto generate: ECDSA/ECDH keys cannot be exported in raw format\n'))
        return 1
      }
    } else if (SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower]?.startsWith('RSA')) {
      const rsaAlgo = SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower]
      const keyLength = length ? parseInt(length, 10) : 2048
      const hashAlgo = hash ? (SUPPORTED_HASH_ALGORITHMS[hash.toLowerCase()] || 'SHA-256') : 'SHA-256'

      if (![1024, 2048, 4096].includes(keyLength)) {
        writeAll(2, new TextEncoder().encode('crypto generate: RSA key length must be 1024, 2048, or 4096\n'))
        return 1
      }

      const keyUsages = rsaAlgo === 'RSA-OAEP' ? ['encrypt', 'decrypt'] : ['sign', 'verify']

      key = await crypto.subtle.generateKey(
        { name: rsaAlgo, modulusLength: keyLength, publicExponent: new Uint8Array([1, 0, 1]), hash: hashAlgo },
        true, keyUsages
      )

      if (keyFormat === 'raw') {
        writeAll(2, new TextEncoder().encode('crypto generate: RSA keys cannot be exported in raw format\n'))
        return 1
      }
    } else if (algoLower === 'hmac') {
      const keyLength = length ? parseInt(length, 10) : 256
      const hashAlgo = hash ? (SUPPORTED_HASH_ALGORITHMS[hash.toLowerCase()] || 'SHA-256') : 'SHA-256'

      key = await crypto.subtle.generateKey({ name: 'HMAC', hash: hashAlgo, length: keyLength }, true, ['sign', 'verify'])

      if (keyFormat === 'pkcs8' || keyFormat === 'spki') {
        writeAll(2, new TextEncoder().encode('crypto generate: HMAC keys cannot be exported in PKCS8 or SPKI format\n'))
        return 1
      }
      exportFormat = keyFormat === 'raw' ? 'raw' : 'jwk'
    } else {
      writeAll(2, new TextEncoder().encode(`crypto generate: unsupported algorithm '${algorithm}'\n`))
      return 1
    }

    let exported
    if ('publicKey' in key && 'privateKey' in key) {
      if (keyFormat === 'spki') exported = await crypto.subtle.exportKey('spki', key.publicKey)
      else if (keyFormat === 'pkcs8') exported = await crypto.subtle.exportKey('pkcs8', key.privateKey)
      else exported = await crypto.subtle.exportKey('jwk', key.privateKey)
    } else {
      exported = await crypto.subtle.exportKey(exportFormat, key)
    }

    let outputData
    if (exportFormat === 'jwk') {
      outputData = new TextEncoder().encode(JSON.stringify(exported, null, 2) + (output ? '' : '\n'))
    } else {
      outputData = new Uint8Array(exported)
    }

    writeOutput(cwd, output, outputData)
    if (output) writeAll(1, new TextEncoder().encode(`Key generated and saved to ${output}\n`))

    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto generate: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function handleEncrypt(cwd, args) {
  const helpText = `Usage: crypto encrypt [OPTIONS]

Encrypt data using various algorithms.

Options:
  --algorithm, -a ALGORITHM    Algorithm (AES-GCM, AES-CBC, AES-CTR, RSA-OAEP)
  --key-file, -k FILE           Key file (JWK format)
  --input, -i FILE              Input file (default: stdin)
  --output, -o FILE             Output file (default: stdout)
  --iv-file FILE                IV/nonce file (for AES, auto-generated if not provided)
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const algorithm = parsed.algorithm || parsed.a
  const keyFile = parsed['key-file'] || parsed.k
  const input = parsed.input || parsed.i
  const output = parsed.output || parsed.o
  const ivFile = parsed['iv-file']

  if (!algorithm || typeof algorithm !== 'string') { writeAll(2, new TextEncoder().encode('crypto encrypt: --algorithm is required\n')); return 1 }
  if (!keyFile || typeof keyFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto encrypt: --key-file is required\n')); return 1 }

  try {
    const algoLower = algorithm.toLowerCase()
    if (!SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower] && algoLower !== 'rsa-oaep') {
      writeAll(2, new TextEncoder().encode(`crypto encrypt: unsupported algorithm '${algorithm}'\n`))
      return 1
    }

    const keyData = readWholeFile(resolve(cwd, keyFile))
    const keyJson = JSON.parse(new TextDecoder().decode(keyData))

    let key
    let encryptParams

    if (SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]) {
      const symAlgo = SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]
      key = await crypto.subtle.importKey('jwk', keyJson, { name: symAlgo }, false, ['encrypt'])

      let iv
      if (ivFile && typeof ivFile === 'string') iv = readWholeFile(resolve(cwd, ivFile))
      else iv = crypto.getRandomValues(new Uint8Array(symAlgo === 'AES-GCM' ? 12 : 16))

      const ivBuffer = toArrayBuffer(iv.buffer)
      if (symAlgo === 'AES-GCM') encryptParams = { name: 'AES-GCM', iv: new Uint8Array(ivBuffer, iv.byteOffset, iv.length) }
      else if (symAlgo === 'AES-CBC') encryptParams = { name: 'AES-CBC', iv: new Uint8Array(ivBuffer, iv.byteOffset, iv.length) }
      else encryptParams = { name: 'AES-CTR', counter: new Uint8Array(ivBuffer, iv.byteOffset, iv.length), length: 128 }
    } else {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
      encryptParams = { name: 'RSA-OAEP' }
    }

    let inputData
    if (input) inputData = readWholeFile(resolve(cwd, input))
    else inputData = readAllStdin()

    const inputBuffer = toArrayBuffer(inputData.buffer)
    const encrypted = await crypto.subtle.encrypt(encryptParams, key, new Uint8Array(inputBuffer, inputData.byteOffset, inputData.length))

    let outputData
    const encryptedArray = new Uint8Array(encrypted)
    if (SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower] && !ivFile) {
      const ivParam = encryptParams.iv
      const ivArray = ivParam instanceof Uint8Array ? ivParam : new Uint8Array(ivParam)
      outputData = new Uint8Array(ivArray.length + encrypted.byteLength)
      outputData.set(ivArray, 0)
      outputData.set(encryptedArray, ivArray.length)
    } else {
      outputData = encryptedArray
    }

    if (output) {
      writeWholeFile(resolve(cwd, output), outputData)
      if (!ivFile && SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]) {
        const ivParam = encryptParams.iv
        const ivArray = ivParam instanceof Uint8Array ? ivParam : new Uint8Array(ivParam)
        writeWholeFile(resolve(cwd, output + '.iv'), ivArray)
        writeAll(1, new TextEncoder().encode(`IV saved to ${output}.iv\n`))
      }
    } else {
      writeAll(1, outputData)
    }

    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto encrypt: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function handleDecrypt(cwd, args) {
  const helpText = `Usage: crypto decrypt [OPTIONS]

Decrypt data using various algorithms.

Options:
  --algorithm, -a ALGORITHM    Algorithm (AES-GCM, AES-CBC, AES-CTR, RSA-OAEP)
  --key-file, -k FILE           Key file (JWK format)
  --input, -i FILE              Input file (default: stdin)
  --output, -o FILE             Output file (default: stdout)
  --iv-file FILE                IV/nonce file (for AES, required if not embedded)
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const algorithm = parsed.algorithm || parsed.a
  const keyFile = parsed['key-file'] || parsed.k
  const input = parsed.input || parsed.i
  const output = parsed.output || parsed.o
  const ivFile = parsed['iv-file']

  if (!algorithm || typeof algorithm !== 'string') { writeAll(2, new TextEncoder().encode('crypto decrypt: --algorithm is required\n')); return 1 }
  if (!keyFile || typeof keyFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto decrypt: --key-file is required\n')); return 1 }

  try {
    const algoLower = algorithm.toLowerCase()
    if (!SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower] && algoLower !== 'rsa-oaep') {
      writeAll(2, new TextEncoder().encode(`crypto decrypt: unsupported algorithm '${algorithm}'\n`))
      return 1
    }

    const keyData = readWholeFile(resolve(cwd, keyFile))
    const keyJson = JSON.parse(new TextDecoder().decode(keyData))

    let inputData
    if (input) inputData = readWholeFile(resolve(cwd, input))
    else inputData = readAllStdin()

    let key
    let decryptParams
    let encryptedData

    if (SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]) {
      const symAlgo = SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]
      key = await crypto.subtle.importKey('jwk', keyJson, { name: symAlgo }, false, ['decrypt'])

      let iv
      if (ivFile && typeof ivFile === 'string') {
        iv = readWholeFile(resolve(cwd, ivFile))
        encryptedData = inputData
      } else {
        const ivLen = symAlgo === 'AES-GCM' ? 12 : 16
        iv = inputData.slice(0, ivLen)
        encryptedData = inputData.slice(ivLen)
      }

      const ivBuffer = toArrayBuffer(iv.buffer)
      if (symAlgo === 'AES-GCM') decryptParams = { name: 'AES-GCM', iv: new Uint8Array(ivBuffer, iv.byteOffset, iv.length) }
      else if (symAlgo === 'AES-CBC') decryptParams = { name: 'AES-CBC', iv: new Uint8Array(ivBuffer, iv.byteOffset, iv.length) }
      else decryptParams = { name: 'AES-CTR', counter: new Uint8Array(ivBuffer, iv.byteOffset, iv.length), length: 128 }
    } else {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'])
      decryptParams = { name: 'RSA-OAEP' }
      encryptedData = inputData
    }

    const encryptedBuffer = toArrayBuffer(encryptedData.buffer)
    const decrypted = await crypto.subtle.decrypt(decryptParams, key, new Uint8Array(encryptedBuffer, encryptedData.byteOffset, encryptedData.length))
    const outputData = new Uint8Array(decrypted)

    writeOutput(cwd, output, outputData)
    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto decrypt: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function handleSign(cwd, args) {
  const helpText = `Usage: crypto sign [OPTIONS]

Sign data using various algorithms.

Options:
  --algorithm, -a ALGORITHM    Algorithm (ECDSA, RSA-PSS, RSASSA-PKCS1-v1_5, HMAC)
  --key-file, -k FILE           Private key file (JWK format)
  --input, -i FILE              Input file (default: stdin)
  --output, -o FILE             Output file (default: stdout)
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const algorithm = parsed.algorithm || parsed.a
  const keyFile = parsed['key-file'] || parsed.k
  const input = parsed.input || parsed.i
  const output = parsed.output || parsed.o

  if (!algorithm || typeof algorithm !== 'string') { writeAll(2, new TextEncoder().encode('crypto sign: --algorithm is required\n')); return 1 }
  if (!keyFile || typeof keyFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto sign: --key-file is required\n')); return 1 }

  try {
    const algoLower = algorithm.toLowerCase()
    if (!SUPPORTED_SIGN_ALGORITHMS[algoLower]) {
      writeAll(2, new TextEncoder().encode(`crypto sign: unsupported algorithm '${algorithm}'\n`))
      return 1
    }

    const keyData = readWholeFile(resolve(cwd, keyFile))
    const keyJson = JSON.parse(new TextDecoder().decode(keyData))

    let key
    let signParams

    if (algoLower === 'ecdsa') {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
      signParams = { name: 'ECDSA', hash: 'SHA-256' }
    } else if (algoLower === 'rsa-pss') {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign'])
      signParams = { name: 'RSA-PSS', saltLength: 32 }
    } else if (algoLower === 'rsassa-pkcs1-v1_5' || algoLower === 'rsassa-pkcs1-v1-5') {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
      signParams = { name: 'RSASSA-PKCS1-v1_5' }
    } else {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      signParams = { name: 'HMAC' }
    }

    let inputData
    if (input) inputData = readWholeFile(resolve(cwd, input))
    else inputData = readAllStdin()

    const inputBuffer = toArrayBuffer(inputData.buffer)
    const signature = await crypto.subtle.sign(signParams, key, new Uint8Array(inputBuffer, inputData.byteOffset, inputData.length))
    const outputData = new Uint8Array(signature)

    writeOutput(cwd, output, outputData)
    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto sign: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function handleVerify(cwd, args) {
  const helpText = `Usage: crypto verify [OPTIONS]

Verify signatures using various algorithms.

Options:
  --algorithm, -a ALGORITHM    Algorithm (ECDSA, RSA-PSS, RSASSA-PKCS1-v1_5, HMAC)
  --key-file, -k FILE           Public key file (JWK format, can use key pair file)
  --input, -i FILE              Input file (default: stdin)
  --signature, -s FILE           Signature file
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const algorithm = parsed.algorithm || parsed.a
  const keyFile = parsed['key-file'] || parsed.k
  const input = parsed.input || parsed.i
  const signatureFile = parsed.signature || parsed.s

  if (!algorithm || typeof algorithm !== 'string') { writeAll(2, new TextEncoder().encode('crypto verify: --algorithm is required\n')); return 1 }
  if (!keyFile || typeof keyFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto verify: --key-file is required\n')); return 1 }
  if (!signatureFile || typeof signatureFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto verify: --signature is required\n')); return 1 }

  try {
    const algoLower = algorithm.toLowerCase()
    if (!SUPPORTED_SIGN_ALGORITHMS[algoLower]) {
      writeAll(2, new TextEncoder().encode(`crypto verify: unsupported algorithm '${algorithm}'\n`))
      return 1
    }

    const keyData = readWholeFile(resolve(cwd, keyFile))
    let keyJson = JSON.parse(new TextDecoder().decode(keyData))

    if (keyJson.d) {
      const publicKeyJson = { kty: keyJson.kty, key_ops: ['verify'], ext: keyJson.ext }
      if (keyJson.kty === 'EC') {
        publicKeyJson.crv = keyJson.crv
        publicKeyJson.x = keyJson.x
        publicKeyJson.y = keyJson.y
      } else if (keyJson.kty === 'RSA') {
        publicKeyJson.n = keyJson.n
        publicKeyJson.e = keyJson.e
      }
      keyJson = publicKeyJson
    }

    let key
    let verifyParams

    if (algoLower === 'ecdsa') {
      const namedCurve = keyJson.crv || 'P-256'
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'ECDSA', namedCurve }, false, ['verify'])
      verifyParams = { name: 'ECDSA', hash: 'SHA-256' }
    } else if (algoLower === 'rsa-pss') {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify'])
      verifyParams = { name: 'RSA-PSS', saltLength: 32 }
    } else if (algoLower === 'rsassa-pkcs1-v1_5' || algoLower === 'rsassa-pkcs1-v1-5') {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      verifyParams = { name: 'RSASSA-PKCS1-v1_5' }
    } else {
      key = await crypto.subtle.importKey('jwk', keyJson, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
      verifyParams = { name: 'HMAC' }
    }

    let inputData
    if (input) inputData = readWholeFile(resolve(cwd, input))
    else inputData = readAllStdin()

    const signature = readWholeFile(resolve(cwd, signatureFile))
    const signatureBuffer = toArrayBuffer(signature.buffer)
    const inputBuffer = toArrayBuffer(inputData.buffer)
    const isValid = await crypto.subtle.verify(
      verifyParams, key,
      new Uint8Array(signatureBuffer, signature.byteOffset, signature.length),
      new Uint8Array(inputBuffer, inputData.byteOffset, inputData.length)
    )

    if (isValid) {
      writeAll(1, new TextEncoder().encode('Signature is valid\n'))
      return 0
    } else {
      writeAll(2, new TextEncoder().encode('Signature is invalid\n'))
      return 1
    }
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto verify: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function handleImport(cwd, args) {
  const helpText = `Usage: crypto import [OPTIONS]

Import keys from various formats.

Options:
  --format, -f FORMAT           Input format (jwk, raw, pkcs8, spki)
  --algorithm, -a ALGORITHM    Algorithm (required for raw format)
  --input, -i FILE              Input file (default: stdin)
  --output, -o FILE             Output file (default: stdout)
  --output-format FORMAT        Output format (jwk, raw, pkcs8, spki) (default: jwk)
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const formatValue = parsed.format || parsed.f || 'jwk'
  const format = (typeof formatValue === 'string' ? formatValue : 'jwk').toLowerCase()
  const algorithm = parsed.algorithm || parsed.a
  const input = parsed.input || parsed.i
  const output = parsed.output || parsed.o
  const outputFormatValue = parsed['output-format'] || 'jwk'
  const outputFormat = (typeof outputFormatValue === 'string' ? outputFormatValue : 'jwk').toLowerCase()

  const keyFormat = SUPPORTED_KEY_FORMATS[format]
  if (!keyFormat) { writeAll(2, new TextEncoder().encode(`crypto import: unsupported input format '${format}'\n`)); return 1 }

  const outputKeyFormat = SUPPORTED_KEY_FORMATS[outputFormat]
  if (!outputKeyFormat) { writeAll(2, new TextEncoder().encode(`crypto import: unsupported output format '${outputFormat}'\n`)); return 1 }

  if (keyFormat !== 'jwk' && (!algorithm || typeof algorithm !== 'string')) {
    writeAll(2, new TextEncoder().encode('crypto import: --algorithm is required for non-JWK formats\n'))
    return 1
  }

  try {
    let inputData
    if (input) inputData = readWholeFile(resolve(cwd, input))
    else inputData = readAllStdin()

    let keyMaterial
    let importAlgorithm
    let keyUsages

    if (keyFormat === 'jwk') {
      const jwk = JSON.parse(new TextDecoder().decode(inputData))
      keyMaterial = jwk

      if (jwk.kty === 'RSA') {
        importAlgorithm = { name: 'RSA-OAEP', hash: 'SHA-256' }
        keyUsages = jwk.d ? ['decrypt', 'encrypt'] : ['encrypt']
      } else if (jwk.kty === 'EC') {
        importAlgorithm = { name: 'ECDSA', namedCurve: jwk.crv || 'P-256' }
        keyUsages = jwk.d ? ['sign', 'verify'] : ['verify']
      } else if (jwk.kty === 'oct') {
        importAlgorithm = { name: 'AES-GCM' }
        keyUsages = ['encrypt', 'decrypt']
      } else {
        writeAll(2, new TextEncoder().encode('crypto import: unsupported key type in JWK\n'))
        return 1
      }
    } else {
      keyMaterial = toArrayBuffer(inputData.buffer)
      const algoLower = algorithm.toLowerCase()

      if (SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower]) {
        importAlgorithm = { name: SUPPORTED_SYMMETRIC_ALGORITHMS[algoLower] }
        keyUsages = ['encrypt', 'decrypt']
      } else if (SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower] === 'ECDSA' || SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower] === 'ECDH') {
        importAlgorithm = { name: SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower], namedCurve: 'P-256' }
        keyUsages = SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower] === 'ECDSA' ? ['sign', 'verify'] : ['deriveKey', 'deriveBits']
      } else if (SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower]?.startsWith('RSA')) {
        importAlgorithm = { name: SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower], hash: 'SHA-256' }
        keyUsages = SUPPORTED_ASYMMETRIC_ALGORITHMS[algoLower] === 'RSA-OAEP' ? ['encrypt', 'decrypt'] : ['sign', 'verify']
      } else if (algoLower === 'hmac') {
        importAlgorithm = { name: 'HMAC', hash: 'SHA-256' }
        keyUsages = ['sign', 'verify']
      } else {
        writeAll(2, new TextEncoder().encode(`crypto import: unsupported algorithm '${algorithm}'\n`))
        return 1
      }
    }

    const key = keyFormat === 'jwk'
      ? await crypto.subtle.importKey('jwk', keyMaterial, importAlgorithm, true, keyUsages)
      : await crypto.subtle.importKey(keyFormat, keyMaterial, importAlgorithm, true, keyUsages)

    let exported
    if ('publicKey' in key && 'privateKey' in key) {
      if (outputKeyFormat === 'spki') exported = await crypto.subtle.exportKey('spki', key.publicKey)
      else if (outputKeyFormat === 'pkcs8') exported = await crypto.subtle.exportKey('pkcs8', key.privateKey)
      else if (outputKeyFormat === 'jwk') exported = await crypto.subtle.exportKey('jwk', key.privateKey)
      else { writeAll(2, new TextEncoder().encode('crypto import: asymmetric keys cannot be exported in raw format\n')); return 1 }
    } else {
      if (outputKeyFormat === 'pkcs8' || outputKeyFormat === 'spki') {
        writeAll(2, new TextEncoder().encode(`crypto import: symmetric keys cannot be exported in ${outputKeyFormat} format\n`))
        return 1
      }
      exported = await crypto.subtle.exportKey(outputKeyFormat, key)
    }

    let outputData
    if (outputKeyFormat === 'jwk') outputData = new TextEncoder().encode(JSON.stringify(exported, null, 2) + (output ? '' : '\n'))
    else outputData = new Uint8Array(exported)

    writeOutput(cwd, output, outputData)
    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto import: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function handleExport(cwd, args) {
  const helpText = `Usage: crypto export [OPTIONS]

Export keys to various formats.

Options:
  --key-file, -k FILE           Key file (JWK format)
  --format, -f FORMAT           Output format (jwk, raw, pkcs8, spki) (default: jwk)
  --output, -o FILE             Output file (default: stdout)
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const keyFile = parsed['key-file'] || parsed.k
  const formatValue = parsed.format || parsed.f || 'jwk'
  const format = (typeof formatValue === 'string' ? formatValue : 'jwk').toLowerCase()
  const output = parsed.output || parsed.o

  if (!keyFile || typeof keyFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto export: --key-file is required\n')); return 1 }

  const keyFormat = SUPPORTED_KEY_FORMATS[format]
  if (!keyFormat) { writeAll(2, new TextEncoder().encode(`crypto export: unsupported format '${format}'\n`)); return 1 }

  try {
    const keyData = readWholeFile(resolve(cwd, keyFile))
    const keyJson = JSON.parse(new TextDecoder().decode(keyData))

    let importAlgorithm
    let keyUsages

    if (keyJson.kty === 'RSA') {
      importAlgorithm = { name: 'RSA-OAEP', hash: 'SHA-256' }
      keyUsages = keyJson.d ? ['decrypt', 'encrypt'] : ['encrypt']
    } else if (keyJson.kty === 'EC') {
      importAlgorithm = { name: 'ECDSA', namedCurve: keyJson.crv || 'P-256' }
      keyUsages = keyJson.d ? ['sign', 'verify'] : ['verify']
    } else if (keyJson.kty === 'oct') {
      importAlgorithm = { name: 'AES-GCM' }
      keyUsages = ['encrypt', 'decrypt']
    } else {
      writeAll(2, new TextEncoder().encode('crypto export: unsupported key type in JWK\n'))
      return 1
    }

    const key = await crypto.subtle.importKey('jwk', keyJson, importAlgorithm, true, keyUsages)
    const exported = await crypto.subtle.exportKey(keyFormat, key)

    let outputData
    if (keyFormat === 'jwk') outputData = new TextEncoder().encode(JSON.stringify(exported, null, 2) + (output ? '' : '\n'))
    else outputData = new Uint8Array(exported)

    writeOutput(cwd, output, outputData)
    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto export: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function handleDerive(cwd, args) {
  const helpText = `Usage: crypto derive [OPTIONS]

Derive keys from passwords or other keys.

Options:
  --algorithm, -a ALGORITHM    Algorithm (PBKDF2, HKDF, ECDH)
  --password, -p PASSWORD        Password (for PBKDF2/HKDF)
  --salt-file FILE               Salt file (for PBKDF2/HKDF)
  --iterations, -i COUNT         Iterations (for PBKDF2, default: 100000)
  --key-file FILE                 Private key file (for ECDH)
  --public-key-file FILE          Public key file (for ECDH)
  --output, -o FILE               Output file (default: stdout, JWK format)
  --help                          Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const algorithm = parsed.algorithm || parsed.a
  const password = parsed.password || parsed.p
  const saltFile = parsed['salt-file']
  const iterations = parsed.iterations || parsed.i
  const keyFile = parsed['key-file']
  const publicKeyFile = parsed['public-key-file']
  const output = parsed.output || parsed.o

  if (!algorithm || typeof algorithm !== 'string') { writeAll(2, new TextEncoder().encode('crypto derive: --algorithm is required\n')); return 1 }

  try {
    const algoLower = algorithm.toLowerCase()
    if (!SUPPORTED_DERIVE_ALGORITHMS[algoLower]) {
      writeAll(2, new TextEncoder().encode(`crypto derive: unsupported algorithm '${algorithm}'\n`))
      return 1
    }

    let derivedKey

    if (algoLower === 'pbkdf2') {
      if (!password || typeof password !== 'string') { writeAll(2, new TextEncoder().encode('crypto derive: --password is required for PBKDF2\n')); return 1 }

      let salt
      if (saltFile && typeof saltFile === 'string') salt = readWholeFile(resolve(cwd, saltFile))
      else salt = crypto.getRandomValues(new Uint8Array(16))

      const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey'])
      const saltBuffer = toArrayBuffer(salt.buffer)
      derivedKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: new Uint8Array(saltBuffer, salt.byteOffset, salt.length), iterations: iterations ? parseInt(iterations, 10) : 100000, hash: 'SHA-256' },
        passwordKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
      )
    } else if (algoLower === 'hkdf') {
      if (!password || typeof password !== 'string') { writeAll(2, new TextEncoder().encode('crypto derive: --password is required for HKDF\n')); return 1 }

      let salt
      if (saltFile && typeof saltFile === 'string') salt = readWholeFile(resolve(cwd, saltFile))
      else salt = crypto.getRandomValues(new Uint8Array(16))

      const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'HKDF', false, ['deriveBits', 'deriveKey'])
      const saltBuffer = toArrayBuffer(salt.buffer)
      derivedKey = await crypto.subtle.deriveKey(
        { name: 'HKDF', salt: new Uint8Array(saltBuffer, salt.byteOffset, salt.length), hash: 'SHA-256', info: new Uint8Array(0) },
        passwordKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
      )
    } else {
      if (!keyFile || typeof keyFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto derive: --key-file is required for ECDH\n')); return 1 }
      if (!publicKeyFile || typeof publicKeyFile !== 'string') { writeAll(2, new TextEncoder().encode('crypto derive: --public-key-file is required for ECDH\n')); return 1 }

      const privateKeyJson = JSON.parse(new TextDecoder().decode(readWholeFile(resolve(cwd, keyFile))))
      const publicKeyJson = JSON.parse(new TextDecoder().decode(readWholeFile(resolve(cwd, publicKeyFile))))

      const privateKey = await crypto.subtle.importKey('jwk', privateKeyJson, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey'])
      const publicKey = await crypto.subtle.importKey('jwk', publicKeyJson, { name: 'ECDH', namedCurve: 'P-256' }, false, [])

      derivedKey = await crypto.subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    }

    const exported = await crypto.subtle.exportKey('jwk', derivedKey)
    const outputData = new TextEncoder().encode(JSON.stringify(exported, null, 2) + '\n')

    writeOutput(cwd, output, outputData)
    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto derive: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

function handleRandom(cwd, args) {
  const helpText = `Usage: crypto random [OPTIONS]

Generate random bytes.

Options:
  --length, -l LENGTH           Number of bytes to generate (default: 32)
  --output, -o FILE             Output file (default: stdout)
  --help                        Display this help`

  const parsed = parseArgs(args)
  if (parsed.help) { writeAll(2, new TextEncoder().encode(helpText + '\n')); return 0 }

  const length = parsed.length || parsed.l
  const output = parsed.output || parsed.o
  const byteLength = length ? parseInt(length, 10) : 32

  if (isNaN(byteLength) || byteLength <= 0) {
    writeAll(2, new TextEncoder().encode('crypto random: --length must be a positive number\n'))
    return 1
  }

  try {
    const randomBytes = crypto.getRandomValues(new Uint8Array(byteLength))
    writeOutput(cwd, output, randomBytes)
    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`crypto random: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const subcommand = args[0]?.toLowerCase()
  const subArgs = args.slice(1)
  const cwd = getcwd()

  switch (subcommand) {
    case 'generate': return await handleGenerate(cwd, subArgs)
    case 'encrypt': return await handleEncrypt(cwd, subArgs)
    case 'decrypt': return await handleDecrypt(cwd, subArgs)
    case 'sign': return await handleSign(cwd, subArgs)
    case 'verify': return await handleVerify(cwd, subArgs)
    case 'import': return await handleImport(cwd, subArgs)
    case 'export': return await handleExport(cwd, subArgs)
    case 'derive': return await handleDerive(cwd, subArgs)
    case 'random': return handleRandom(cwd, subArgs)
    default:
      writeAll(2, new TextEncoder().encode(`Error: Unknown subcommand: ${subcommand}\nRun "crypto --help" for usage information\n`))
      return 1
  }
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`crypto: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
