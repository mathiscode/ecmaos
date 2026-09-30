/**
 * The process table, read the way Linux tools read it: from `/proc`.
 *
 * `ps` and `killall` used a `ps_list` custom syscall that wrote JSON into a scratch file. Procfs
 * already synthesizes everything they need (`/proc/<pid>/status`, `comm`, `cmdline`, `exe`), and a
 * program that reads it needs no main thread, so it keeps working when the caller is a worker shell.
 * `free.mjs` is the same idea for `/proc/meminfo`.
 */

const { open, read, close, readdir, readlink, O_RDONLY } = globalThis.ecmaosSyscalls

/** The whole of `path` as text. Procfs files report size 0, so this reads to EOF rather than to a `stat` size. */
export function readText(path) {
  const fd = open(path, O_RDONLY)
  try {
    const chunks = []
    let total = 0
    while (true) {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      total += n
      if (n < buffer.length) break
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
    return new TextDecoder().decode(joined)
  } finally {
    close(fd)
  }
}

/** `Key:\tvalue` lines of `/proc/<pid>/status`. */
export function parseStatus(text) {
  const fields = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return fields
}

/**
 * Every process `/proc` lists: `{ pid, ppid, uid, command }`, lowest pid first. A process that exits
 * between the listing and the read is skipped rather than reported as an error, as `ps` does.
 * A context that never `execve`d a program (no `exe`, no `argv`) is labelled in brackets, the way
 * Linux labels a kernel thread.
 */
export function listProcesses() {
  const processes = []
  for (const name of readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const status = parseStatus(readText(`/proc/${pid}/status`))
      const comm = readText(`/proc/${pid}/comm`).trim()
      let exe = ''
      try { exe = readlink(`/proc/${pid}/exe`) } catch { /* no image */ }
      const hasImage = exe !== '' || readText(`/proc/${pid}/cmdline`) !== ''
      processes.push({
        pid,
        ppid: Number(status.PPid ?? 0),
        uid: Number(String(status.Uid ?? '0').split(/\s+/)[0]),
        command: hasImage ? comm : '[kernel]'
      })
    } catch { /* gone */ }
  }
  return processes.sort((a, b) => a.pid - b.pid)
}
