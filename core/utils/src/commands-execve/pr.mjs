/** `pr`: paginate or columnate files for printing, as GNU pr does. The layouts are in lib/pr-render.mjs. */

import { getopt } from './lib/getopt.mjs'
import { readFdBytes, readFileBytes, writeFdBytes } from './lib/bytes.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'
import { runPr } from './lib/pr-render.mjs'

const { argv, env, exit, getcwd, stat } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const UTC_NAMES = /^(UTC|GMT|UCT|Z|Etc\/UTC|Etc\/GMT)(0|\+0|-0)?$/

/** One character per byte, as pr reads its input */
function latin1(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return out
}

function toBytes(text) {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

function zoneName(ms) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')
    return part?.value ?? 'UTC'
  } catch { return 'UTC' }
}

try {
  const cwd = getcwd()
  const utc = UTC_NAMES.test(env.TZ ?? '')
  const host = {
    readFile(name) {
      const path = resolve(cwd, name)
      try {
        const info = stat(path)
        return { content: latin1(readFileBytes(path)), mtime: info.mtimeMs }
      } catch (error) {
        const failure = new Error(reasonOf(error))
        failure.reason = reasonOf(error)
        throw failure
      }
    },
    readStdin: () => latin1(readFdBytes(0)),
    now: () => Date.now(),
    utc,
    zone: utc ? 'UTC' : zoneName(Date.now())
  }
  const result = runPr(argv.slice(1), host, getopt)
  if (result.out) writeFdBytes(1, toBytes(result.out))
  if (result.err) writeFdBytes(2, encoder.encode(result.err))
  exit(result.status)
} catch (error) {
  writeFdBytes(2, encoder.encode(`pr: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
