/**
 * `service`: run a System V init script, as Debian's does. The actions the service manager knows (`start`, `stop`,
 * `restart`, `try-restart`, `reload`, `force-reload`, `status`) go through `systemctl`, which runs the script as a
 * unit or the unit of that name; any other action runs `/etc/init.d/NAME ACTION` directly, with a clean environment.
 * `--status-all` runs every script's `status` and shows `[ + ]` running, `[ - ]` stopped and `[ ? ]` unknown.
 */

const { argv, env, exit, writeAll, readdir, stat, spawn, waitpid, open, close, O_WRONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text))

const INIT_D = '/etc/init.d'
const MANAGED = { start: 'start', stop: 'stop', restart: 'restart', 'try-restart': 'try-restart', condrestart: 'try-restart', reload: 'reload', 'force-reload': 'reload-or-restart', status: 'status' }
const CLEAN_ENV = () => ({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: env.TERM ?? 'dumb', LANG: env.LANG ?? 'C' })

const usage = `Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]\n`

const executable = path => { try { const info = stat(path); return (info.mode & 0o170000) === 0o100000 && (info.mode & 0o111) !== 0 } catch { return false } }
const exists = path => { try { stat(path); return true } catch { return false } }

async function run(program, args, childEnv, quiet = false) {
  let pid
  const sink = quiet ? open('/dev/null', O_WRONLY) : undefined
  try {
    pid = await spawn(program, [program, ...args], { cwd: '/', env: childEnv, ...(sink !== undefined ? { fds: { 1: sink, 2: sink } } : {}) })
  } catch (error) {
    err(`service: ${program}: ${error?.message ?? error}\n`)
    return 127
  } finally {
    if (sink !== undefined) close(sink)
  }
  const done = await waitpid(pid, false)
  return done.signal ? 128 + done.signal : done.code
}

async function main() {
  const args = argv.slice(1)
  if (args.length === 0) { err(usage); return 1 }
  if (args[0] === '--help' || args[0] === '-h') { out(usage); return 0 }
  if (args[0] === '--version') { out('service ver. 1.0 (ecmaOS)\n'); return 0 }
  if (args[0] === '--status-all') {
    let names = []
    try { names = readdir(INIT_D).sort() } catch { /* none */ }
    for (const name of names) {
      const path = `${INIT_D}/${name}`
      if (name === 'README' || name === 'rc' || name === 'rcS' || name.startsWith('.') || !executable(path)) continue
      const code = await run(path, ['status'], CLEAN_ENV(), true)
      out(` [ ${code === 0 ? '+' : code === 3 ? '-' : '?'} ]  ${name}\n`)
    }
    return 0
  }

  const [name, action, ...rest] = args
  if (!action) { err(usage); return 1 }
  if (action === '--full-restart') {
    const stopped = await run('/bin/systemctl', ['stop', name], { ...env })
    return stopped === 0 ? await run('/bin/systemctl', ['start', name], { ...env }) : stopped
  }
  const script = `${INIT_D}/${name}`
  const unitExists = ['/etc/systemd/system', '/lib/systemd/system'].some(dir => exists(`${dir}/${name}.service`))
  if (MANAGED[action] && (unitExists || executable(script))) return await run('/bin/systemctl', [MANAGED[action], `${name}.service`, ...rest], { ...env })
  if (!executable(script)) { err(`${name}: unrecognized service\n`); return 1 }
  return await run(script, [action, ...rest], CLEAN_ENV())
}

try {
  exit(await main())
} catch (error) {
  err(`service: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
}
