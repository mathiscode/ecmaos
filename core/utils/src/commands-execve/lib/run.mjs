/**
 * What the programs that run other programs (`xargs`, `timeout`, `nohup`, `watch`) share: finding one on
 * `PATH` the way a shell does, reading all of a descriptor, and running a child to completion.
 */

const sys = globalThis.ecmaosSyscalls
const { env, stat, isDirectory, spawn, waitpid, read, pipe, close, getcwd } = sys

const isFile = path => { try { return !isDirectory(path) && (stat(path), true) } catch { return false } }

/** A program by name, searching `PATH`, or undefined. A name with a slash is a path. */
export function findProgram(name) {
  if (name.includes('/')) return isFile(name) ? name : undefined
  for (const dir of (env.PATH ?? '/bin:/usr/bin').split(':')) {
    if (dir && isFile(`${dir}/${name}`)) return `${dir}/${name}`
  }
  return undefined
}

/** Everything readable from `fd`. */
export function readAll(fd = 0) {
  const chunks = []
  let total = 0
  for (;;) {
    const buffer = new Uint8Array(65536)
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    total += n
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

/**
 * A descriptor that reads end of file at once, for a child that must not take the terminal's input. It is a pipe
 * with nothing in it and no writer, not `/dev/null`: a read of that device reports a full buffer for ever.
 */
export function openDevNull() {
  const [reader, writer] = pipe()
  close(writer)
  return reader
}

/** Whether a wait ended with `EINTR`, a signal with a handler. */
const interrupted = error => `${error?.code} ${error?.message ?? error}`.includes('EINTR')

/** Waits for `pid` to end, resuming a wait a signal cut short. Resolves to `{ code?, signal? }`. */
export async function waitFor(pid) {
  for (;;) {
    try { return await waitpid(pid, false) } catch (error) { if (!interrupted(error)) throw error }
  }
}

/** The exit status a shell reports for how a child ended. */
export const statusOf = done => done.signal ? 128 + done.signal : done.code

/**
 * Runs `program` with `argv` and resolves to `{ status, signal }`. `fds` maps child descriptors to ours and
 * defaults to the three standard ones; `cwd` and `env` default to this program's.
 */
export async function run(program, argv, { fds, env: childEnv, cwd } = {}) {
  const pid = await spawn(program, argv, { cwd: cwd ?? getcwd(), env: childEnv ?? env, fds })
  const done = await waitFor(pid)
  return { status: statusOf(done), signal: done.signal, pid }
}
