/**
 * `tsc`, the TypeScript compiler, as tsrs (Cloudflare and VoidZero's Rust port of TypeScript 7) built to WebAssembly. It
 * reads and writes the machine's files through the process's syscalls. The module is the one in the `@tsrs/wasm`
 * package that `install @ecmaos-apps/tsc` installs beside this one (or the file `TSRS_WASM` names).
 */

import { runTscAsync, makeRequest, parseReply } from '@tsrs/wasm/core'
import { systemFileSystem, readFileBytes } from './host.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, writeAll, getcwd } = sys
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`tsc: ${text}\n`))

// `install` puts @tsrs/wasm, which this package depends on at one exact version (written in by the build), here
const DEFAULT_MODULE = `/usr/lib/@tsrs/wasm/${TSRS_VERSION}/tsrs.wasm`

const usage = `Usage: tsc [OPTIONS] [FILE]...
Type-check TypeScript, and emit JavaScript, with tsrs: a Rust port of TypeScript 7, run as WebAssembly.

  -h, --help       display this help and exit
  --version        print the version of tsc that tsrs matches
  --json-diagnostics  print the diagnostics as JSON

Every other option is tsc's own (-p, --noEmit, --outDir, --strict, -b, ...); see 'tsc --all'.
The compiler is read from ${DEFAULT_MODULE}
(installed with this package), or from the file the environment variable TSRS_WASM names.`

async function main() {
  const args = argv.slice(1)
  if (args[0] === '-h' || args[0] === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }

  const json = args.includes('--json-diagnostics')
  const path = env?.TSRS_WASM || DEFAULT_MODULE
  let bytes
  try { bytes = readFileBytes(sys, path) } catch (error) {
    err(`cannot read ${path}: ${error?.message ?? error}${env?.TSRS_WASM ? '' : " (try 'install @ecmaos-apps/tsc --reinstall')"}`)
    return 2
  }
  const module = await WebAssembly.compile(bytes)

  let tty = false
  try { sys.tcgetattr(1); tty = true } catch { /* not a terminal */ }

  const request = makeRequest(args.filter(arg => arg !== '--json-diagnostics'), { cwd: getcwd(), json, tty })
  const result = await runTscAsync(module, request, systemFileSystem(sys), {
    env,
    stdout: chunk => writeAll(1, chunk),
    stderr: chunk => writeAll(2, chunk)
  })
  if (json) writeAll(1, encoder.encode(JSON.stringify(parseReply(result.reply), null, 2) + '\n'))
  return result.exitCode
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
