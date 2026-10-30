/** Node's `os`, from `/proc`, `/etc` and what the browser says about the machine */
const sys = globalThis.ecmaosSyscalls

const read = path => { try { return require('node:fs').readFileSync(path, 'utf8') } catch { return undefined } }

const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGWINCH: 28 }

function userInfo() {
  const uid = sys.getuid()
  const line = (read('/etc/passwd') ?? '').split('\n').map(entry => entry.split(':')).find(fields => Number(fields[2]) === uid)
  return { uid, gid: sys.getgid(), username: line?.[0] ?? (uid === 0 ? 'root' : String(uid)), homedir: line?.[5] ?? process.env.HOME ?? '/', shell: line?.[6] ?? '/bin/sh' }
}

module.exports = {
  EOL: '\n',
  devNull: '/dev/null',
  constants: { signals, errno: {}, priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 } },
  platform: () => 'linux',
  type: () => 'Linux',
  arch: () => 'x64',
  machine: () => 'x86_64',
  endianness: () => 'LE',
  release: () => (read('/proc/sys/kernel/osrelease') ?? '6.0.0').trim(),
  version: () => (read('/proc/version') ?? 'ecmaOS').trim(),
  hostname: () => (read('/etc/hostname') ?? read('/proc/sys/kernel/hostname') ?? 'localhost').trim(),
  homedir: () => process.env.HOME ?? userInfo().homedir,
  tmpdir: () => (process.env.TMPDIR || '/tmp').replace(/(.)\/$/, '$1'),
  userInfo,
  cpus: () => Array.from({ length: globalThis.navigator?.hardwareConcurrency ?? 1 }, () => ({ model: 'browser', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
  availableParallelism: () => globalThis.navigator?.hardwareConcurrency ?? 1,
  totalmem: () => (globalThis.navigator?.deviceMemory ?? 4) * 1024 ** 3,
  freemem: () => Math.max(0, (globalThis.navigator?.deviceMemory ?? 4) * 1024 ** 3 - (performance.memory?.usedJSHeapSize ?? 0)),
  uptime: () => Number((read('/proc/uptime') ?? '0').split(' ')[0]) || performance.now() / 1000,
  loadavg: () => [0, 0, 0],
  networkInterfaces: () => ({}),
  getPriority: () => 0,
  setPriority: () => {}
}
