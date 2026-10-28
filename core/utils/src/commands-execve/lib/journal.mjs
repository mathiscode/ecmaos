/**
 * The system log as `journalctl` and `systemctl status` read it. There is no binary journal: the entries are the lines
 * of `/var/log/messages` (what `/dev/log` receives, `Mon dd hh:mm:ss host tag[pid]: text`) and of the kernel log,
 * `/var/log/kernel.log` (`MM/DD/YYYY hh:mm:ss.mmm [LEVEL] text`, shown with the tag `kernel`), each with its rotated
 * `.1` before it. Neither file keeps a message's priority or year, so syslog entries are taken as level 6 (info) and as
 * this year's unless that would put them in the future.
 */

const { open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

export const MESSAGES = '/var/log/messages'
export const KERNEL_LOG = '/var/log/kernel.log'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const KERNEL_LEVELS = { FATAL: 2, ERROR: 3, WARN: 4, INFO: 6, DEBUG: 7, TRACE: 7, SILLY: 7 }

/** A file's text, or undefined when it cannot be read; `denied` notes a refusal */
export function readLog(path, denied) {
  let fd
  try { fd = open(path, O_RDONLY) } catch (error) {
    if (/EACCES|EPERM/.test(`${error?.code} ${error?.message}`)) denied?.add(path)
    return undefined
  }
  const decoder = new TextDecoder()
  const chunks = []
  const buffer = new Uint8Array(65536)
  try {
    for (;;) {
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
    }
  } finally { close(fd) }
  chunks.push(decoder.decode())
  return chunks.join('')
}

/** The entries of `/var/log/messages` text */
export function parseMessages(text, now = Date.now()) {
  const entries = []
  const year = new Date(now).getFullYear()
  for (const line of text.split('\n')) {
    const match = /^(\w{3}) ([ \d]\d) (\d\d):(\d\d):(\d\d) (\S+) (.*)$/.exec(line)
    if (!match) continue
    const month = MONTHS.indexOf(match[1])
    if (month === -1) continue
    let time = new Date(year, month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])).getTime()
    if (time > now + 86_400_000) time = new Date(year - 1, month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])).getTime()
    const tagged = /^([^\s:[]+)(?:\[(\d+)\])?: (.*)$/.exec(match[7])
    entries.push({
      time,
      host: match[6],
      tag: tagged ? tagged[1] : '',
      pid: tagged?.[2] ? Number(tagged[2]) : undefined,
      message: tagged ? tagged[3] : match[7],
      level: 6,
      kernel: false
    })
  }
  return entries
}

/** The entries of the kernel log's text; a message may run over several lines */
export function parseKernelLog(text, host) {
  const entries = []
  for (const line of text.split('\n')) {
    const match = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)\.(\d{3}) \[(\w+)\] ?(.*)$/.exec(line)
    if (match) {
      entries.push({
        time: new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]), Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7])).getTime(),
        host,
        tag: 'kernel',
        pid: undefined,
        message: match[9],
        level: KERNEL_LEVELS[match[8].toUpperCase()] ?? 6,
        kernel: true
      })
    } else if (line.trim() && entries.length) entries[entries.length - 1].message += ` ${line.trim()}`
  }
  return entries
}

/** Every entry, oldest first: syslog ones, and the kernel's with `kernel` true (or only those, or none) */
export function readJournal({ kernel = true, syslog = true, host = 'localhost', denied } = {}) {
  const entries = []
  if (syslog) {
    for (const path of [`${MESSAGES}.1`, MESSAGES]) {
      const text = readLog(path, denied)
      if (text) entries.push(...parseMessages(text))
    }
  }
  if (kernel) {
    for (const path of [`${KERNEL_LOG}.1`, KERNEL_LOG]) {
      const text = readLog(path, denied)
      if (text) entries.push(...parseKernelLog(text, host))
    }
  }
  // stable: entries of the same second keep the order their file has them in
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.time - b.entry.time || a.index - b.index).map(({ entry }) => entry)
}

/** `Oct 27 14:33:15`, as the short output format starts a line */
export function shortTime(ms) {
  const date = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${MONTHS[date.getMonth()]} ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** An entry as `journalctl` prints it in the short format */
export function formatShort(entry) {
  return `${shortTime(entry.time)} ${entry.host} ${entry.tag ? `${entry.tag}${entry.pid !== undefined ? `[${entry.pid}]` : ''}: ` : ''}${entry.message}`
}

/** The entries that belong to a unit: init's messages naming it, and its processes' output, logged under its identifiers */
export function unitMatcher(unit, identifiers = []) {
  const ids = new Set(identifiers)
  const named = new RegExp(`(^|[\\s'"])${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s:.'"]|$)`)
  return entry => (entry.tag === 'init' && entry.pid === 1 && named.test(entry.message)) || (entry.tag !== 'init' && entry.tag !== 'kernel' && ids.has(entry.tag))
}

/** When this boot began, from `/proc/stat`'s `btime`, in ms */
export function bootTime() {
  const text = readLog('/proc/stat') ?? ''
  const match = /^btime (\d+)/m.exec(text)
  if (match) return Number(match[1]) * 1000
  const uptime = Number((readLog('/proc/uptime') ?? '').split(' ')[0])
  return Number.isFinite(uptime) && uptime > 0 ? Date.now() - uptime * 1000 : 0
}
