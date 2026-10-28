/** The process table as `/proc` gives it, for `pstree`, `fuser` and `lslocks`. */

const { readdir, open, read, close, readlink, O_RDONLY } = globalThis.ecmaosSyscalls
const decoder = new TextDecoder()

export function readSmall(path) {
  let fd
  try { fd = open(path, O_RDONLY) } catch { return undefined }
  try {
    const chunks = []
    const buffer = new Uint8Array(65536)
    for (;;) {
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
    }
    return chunks.join('') + decoder.decode()
  } catch { return undefined } finally { close(fd) }
}

/** Every process: `{ pid, ppid, pgrp, comm, uid, args }` */
export function processes() {
  const list = []
  let names = []
  try { names = readdir('/proc') } catch { return list }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const stat = readSmall(`/proc/${name}/stat`)
    if (!stat) continue
    const end = stat.lastIndexOf(')')
    const fields = stat.slice(end + 2).split(' ')
    const status = readSmall(`/proc/${name}/status`) ?? ''
    const cmdline = (readSmall(`/proc/${name}/cmdline`) ?? '').split('\0').filter(Boolean)
    list.push({
      pid: Number(name),
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      comm: stat.slice(stat.indexOf('(') + 1, end),
      uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? 0),
      args: cmdline
    })
  }
  return list.sort((a, b) => a.pid - b.pid)
}

/** Where each of a process's descriptors, and its cwd, root and exe, point: `[{ fd, path }]` with fd 'cwd', 'root', 'exe' or a number */
export function openFiles(pid) {
  const found = []
  for (const name of ['cwd', 'root', 'exe']) {
    try { const path = readlink(`/proc/${pid}/${name}`); if (path) found.push({ fd: name, path }) } catch { /* none */ }
  }
  let fds = []
  try { fds = readdir(`/proc/${pid}/fd`) } catch { /* gone, or not ours to see */ }
  for (const fd of fds) {
    try { found.push({ fd: Number(fd), path: readlink(`/proc/${pid}/fd/${fd}`) }) } catch { /* closed meanwhile */ }
  }
  return found
}

/** `/etc/passwd`'s names by uid */
export function userNames() {
  const names = new Map()
  for (const line of (readSmall('/etc/passwd') ?? '').split('\n')) {
    const [name, , uid] = line.split(':')
    if (name && uid !== undefined) names.set(Number(uid), name)
  }
  return names
}
