/** The call every module command makes: send the request to the kernel, print the lines it returns, exit with its code. */

import { readBackAndDelete, scratchPath } from './scratch.mjs'
import { resolvePath } from './paths.mjs'

const { write, custom, open, read, close, unlink, getcwd } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()

export const absolute = target => resolvePath(getcwd(), target)

export function die(command, message) {
  write(2, encoder.encode(`${command}: ${message}\n`))
  return 1
}

export async function moduleCall(request) {
  const path = scratchPath('module')
  await custom('module_ctl', JSON.stringify(request), path)
  const { code, lines } = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  for (const { stream, text } of lines) write(stream === 'err' ? 2 : 1, encoder.encode(text + '\n'))
  return code
}

/** `--help` text goes to stdout and ends the program */
export function help(usage) {
  write(1, encoder.encode(usage + '\n'))
  return 0
}
