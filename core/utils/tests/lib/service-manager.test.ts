import { describe, expect, it } from 'vitest'

import { enablement, loadUnits, parseTimespan, parseUnitText, serviceFromScript, serviceFromText, splitCommand, startOrder } from '../../src/lib/unit-file.ts'
import type { UnitReader } from '../../src/lib/unit-file.ts'
import { ServiceManager } from '../../src/lib/service-manager.ts'
import type { ExitStatus, ServiceHost } from '../../src/lib/service-manager.ts'

/** A filesystem of files and links, for the unit reader */
function reader(files: Record<string, string>, links: Record<string, string> = {}, executable: string[] = []): UnitReader {
  return {
    readdir: path => [...new Set([...Object.keys(files), ...Object.keys(links)].filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')).map(file => file.slice(path.length + 1)))],
    readFile: path => files[path],
    readlink: path => links[path],
    isExecutable: path => executable.includes(path) || path.startsWith('/bin/')
  }
}

describe('unit files', () => {
  it('parses sections, lists, an empty value clearing a list, and continued lines', () => {
    const sections = parseUnitText('[Unit]\nDescription=One\n# comment\n[Service]\nExecStart=/bin/a\nExecStart=\nExecStart=/bin/b \\\n  --flag\nEnvironment=A=1\n')
    expect(sections['Unit']!['Description']).toEqual(['One'])
    expect(sections['Service']!['ExecStart']).toEqual(['/bin/b --flag'])
  })

  it('splits a command line as systemd does, with the unit\'s environment', () => {
    expect(splitCommand('/bin/echo "two words" \'single $X\' ${X} $Y', { X: 'x', Y: 'a b' })).toEqual(['/bin/echo', 'two words', 'single $X', 'x', 'a', 'b'])
  })

  it('reads a service\'s settings and their defaults', () => {
    const unit = serviceFromText('web.service', '/etc/systemd/system/web.service', '[Unit]\nAfter=network.target db.service\n[Service]\nExecStart=-/bin/web\nRestart=on-failure\nRestartSec=5\nUser=www\nEnvironment="A=1" B=2\n[Install]\nWantedBy=multi-user.target\n')
    expect(unit).toMatchObject({ type: 'simple', restart: 'on-failure', restartSec: 5000, user: 'www', environment: { A: '1', B: '2' }, after: ['network.target', 'db.service'], wantedBy: ['multi-user.target'], timeoutStopSec: 10000 })
    expect(unit.execStart).toEqual([{ line: '/bin/web', ignoreFailure: true }])
    expect(serviceFromText('x.service', '', '[Service]\nType=simple\n').warnings.some(warning => warning.endsWith('Refusing.'))).toBe(true)
  })

  it('takes time spans in systemd\'s units', () => {
    expect(parseTimespan('90')).toBe(90_000)
    expect(parseTimespan('1min 30s')).toBe(90_000)
    expect(parseTimespan('500ms')).toBe(500)
    expect(parseTimespan('infinity')).toBe(Infinity)
    expect(parseTimespan('soon')).toBeUndefined()
  })

  it('makes a SysV script a unit from its LSB header', () => {
    const unit = serviceFromScript('legacy', '/etc/init.d/legacy', '#!/bin/sh\n### BEGIN INIT INFO\n# Short-Description: old thing\n### END INIT INFO\n')
    expect(unit).toMatchObject({ name: 'legacy.service', sysv: true, description: 'LSB: old thing', remainAfterExit: true })
    expect(unit.execStart[0]!.line).toBe('/etc/init.d/legacy start')
  })

  it('loads /etc over /lib, adds drop-ins, hides masked units and says what is enabled', () => {
    const files = {
      '/lib/systemd/system/a.service': '[Service]\nExecStart=/bin/lib-a\n[Install]\nWantedBy=multi-user.target\n',
      '/etc/systemd/system/a.service': '[Service]\nExecStart=/bin/etc-a\n[Install]\nWantedBy=multi-user.target\n',
      '/etc/systemd/system/a.service.d/override.conf': '[Service]\nEnvironment=X=1\n',
      '/lib/systemd/system/b.service': '[Service]\nExecStart=/bin/b\n',
      '/lib/systemd/system/c.service': '[Service]\nExecStart=/bin/c\n',
      '/etc/init.d/old': '#!/bin/sh\n'
    }
    const links = { '/etc/systemd/system/c.service': '/dev/null', '/etc/systemd/system/multi-user.target.wants/a.service': '/etc/systemd/system/a.service', '/etc/rc3.d/S01old': '../init.d/old' }
    const fs = reader(files, links, ['/etc/init.d/old'])
    const units = loadUnits(fs)
    expect(units.get('a.service')!.execStart[0]!.line).toBe('/bin/etc-a')
    expect(units.get('a.service')!.environment).toEqual({ X: '1' })
    expect(units.has('c.service')).toBe(false)
    expect(units.get('old.service')!.sysv).toBe(true)
    expect(enablement(fs, units.get('a.service'), 'a.service')).toBe('enabled')
    expect(enablement(fs, units.get('b.service'), 'b.service')).toBe('static')
    expect(enablement(fs, undefined, 'c.service')).toBe('masked')
    expect(enablement(fs, units.get('old.service'), 'old.service')).toBe('enabled')
  })

  it('orders units by After= and Before=', () => {
    const make = (name: string, text: string) => serviceFromText(name, '', `[Unit]\n${text}\n[Service]\nExecStart=/bin/x\n`)
    const order = startOrder([make('c.service', 'After=b.service'), make('b.service', 'After=a.service'), make('a.service', ''), make('d.service', 'Before=a.service')])
    expect(order.map(unit => unit.name)).toEqual(['d.service', 'a.service', 'b.service', 'c.service'])
  })
})

/** A host whose processes are fake: each spawn records the argv and gets the next pid; tests end them with `exit` */
class FakeHost implements ServiceHost {
  files: Record<string, string> = {}
  links: Record<string, string> = {}
  spawned: Array<{ pid: number, argv: string[], env: Record<string, string>, cwd: string, credentials?: unknown }> = []
  signals: Array<[number, number]> = []
  live = new Set<number>()
  logs: string[] = []
  written: Record<string, string> = {}
  timers: Array<{ at: number, callback: () => void }> = []
  clock = 1000
  nextPid = 100
  manager!: ServiceManager
  /** How a spawned program behaves: a status to exit with at once, or undefined to keep running */
  behaviour: (argv: string[]) => ExitStatus | undefined = () => undefined

  get reader() { return reader(this.files, this.links) }
  async spawn(argv: string[], options: { cwd: string, env: Record<string, string>, credentials?: unknown }) {
    const pid = this.nextPid++
    this.spawned.push({ pid, argv, ...options })
    this.live.add(pid)
    const status = this.behaviour(argv)
    // as with init, the exit comes in a later event than the spawn's answer
    if (status) setTimeout(() => this.exit(pid, status), 0)
    return pid
  }
  async killpg(pgid: number, signal: number) {
    this.signals.push([pgid, signal])
    if (this.live.has(pgid)) setTimeout(() => this.exit(pgid, { signal }), 0)
  }
  async kill(pid: number, signal: number) { this.signals.push([pid, signal]) }
  alive(pid: number) { return this.live.has(pid) }
  writeFile(path: string, text: string) { this.written[path] = text }
  mkdir() {}
  account(name: string) { return name === 'www' ? { name, uid: 33, gid: 33, groups: [], home: '/var/www', shell: '/bin/sh' } : undefined }
  groupId(name: string) { return name === 'www' ? 33 : undefined }
  syslog(message: string) { this.logs.push(message) }
  now() { return this.clock }
  setTimer(callback: () => void, ms: number) { const timer = { at: this.clock + ms, callback }; this.timers.push(timer); return timer }
  clearTimer(timer: unknown) { this.timers = this.timers.filter(candidate => candidate !== timer) }
  /** A process ended: init reaps it and tells the manager */
  exit(pid: number, status: ExitStatus) {
    if (!this.live.delete(pid)) return
    this.manager.exited(pid, status)
  }
  /** Moves the clock on, firing the timers that come due */
  async advance(ms: number) {
    const end = this.clock + ms
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter(timer => timer !== due)
      this.clock = due.at
      due.callback()
      await settle()
    }
    this.clock = end
  }
  state(name: string) { return JSON.parse(this.written['/run/systemd/state.json'] ?? '{"units":{}}').units[name] }
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

function setup(files: Record<string, string>) {
  const host = new FakeHost()
  host.files = files
  host.manager = new ServiceManager(host)
  host.manager.reload()
  return host
}

describe('the service manager', () => {
  it('starts a simple service under systemd-cat in its own group, and stops its group', async () => {
    const host = setup({ '/etc/systemd/system/web.service': '[Unit]\nDescription=Web\n[Service]\nExecStart=/bin/web --port 80\nUser=www\nEnvironment=MODE=prod\n' })
    await host.manager.start('web.service')
    const [web] = host.spawned
    expect(web!.argv).toEqual(['/bin/systemd-cat', '-t', 'web', '--', '/bin/web', '--port', '80'])
    expect(web!.env).toMatchObject({ MODE: 'prod', HOME: '/var/www', USER: 'www' })
    expect(web!.credentials).toEqual({ uid: 33, gid: 33, groups: [] })
    expect(web!.cwd).toBe('/var/www')
    expect(host.state('web.service')).toMatchObject({ ActiveState: 'active', SubState: 'running', MainPID: web!.pid, Identifiers: ['web'] })
    expect(host.logs).toContain('Started web.service - Web.')
    await host.manager.stop('web.service')
    expect(host.signals).toContainEqual([web!.pid, 15])
    expect(host.state('web.service')).toMatchObject({ ActiveState: 'inactive', SubState: 'dead' })
    expect(host.logs).toContain('Stopped web.service - Web.')
  })

  it('kills a service that ignores SIGTERM once TimeoutStopSec= passes', async () => {
    const host = setup({ '/etc/systemd/system/stubborn.service': '[Service]\nExecStart=/bin/stubborn\nTimeoutStopSec=2\n' })
    await host.manager.start('stubborn.service')
    const pid = host.spawned[0]!.pid
    host.killpg = async (pgid, signal) => { host.signals.push([pgid, signal]); if (signal === 9) setTimeout(() => host.exit(pgid, { signal }), 0) }
    const stopping = host.manager.stop('stubborn.service')
    await settle()
    await host.advance(2000)
    await stopping
    expect(host.signals).toEqual([[pid, 15], [pid, 9]])
    expect(host.logs).toContain("stubborn.service: State 'stop-sigterm' timed out. Killing.")
  })

  it('fails a service that exits with an error, and restarts one with Restart=on-failure until the start limit', async () => {
    const host = setup({
      '/etc/systemd/system/bad.service': '[Service]\nExecStart=/bin/bad\n',
      '/etc/systemd/system/flaky.service': '[Service]\nExecStart=/bin/flaky\nRestart=on-failure\nRestartSec=1\n'
    })
    host.behaviour = () => ({ code: 2 })
    await host.manager.start('bad.service').catch(() => {})
    await settle()
    expect(host.state('bad.service')).toMatchObject({ ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: 2 })
    await host.manager.start('flaky.service').catch(() => {})
    for (let i = 0; i < 8; i++) { await settle(); await host.advance(1000) }
    expect(host.state('flaky.service')).toMatchObject({ ActiveState: 'failed', Result: 'start-limit-hit' })
    expect(host.logs).toContain('flaky.service: Scheduled restart job, restart counter is at 4.')
  })

  it('does not restart a service that ends cleanly under Restart=on-failure, and does under Restart=always', async () => {
    const host = setup({
      '/etc/systemd/system/done.service': '[Service]\nExecStart=/bin/done\nRestart=on-failure\n',
      '/etc/systemd/system/always.service': '[Service]\nExecStart=/bin/always\nRestart=always\nRestartSec=1\n'
    })
    await host.manager.start('done.service')
    host.exit(host.spawned[0]!.pid, { code: 0 })
    expect(host.state('done.service')).toMatchObject({ ActiveState: 'inactive', Result: 'success' })
    await host.manager.start('always.service')
    host.exit(host.spawned[1]!.pid, { code: 0 })
    expect(host.state('always.service').SubState).toBe('auto-restart')
    await host.advance(1000)
    await settle()
    expect(host.spawned).toHaveLength(3)
    expect(host.state('always.service')).toMatchObject({ ActiveState: 'active', NRestarts: 1 })
  })

  it('runs a oneshot unit\'s commands in order and stays active with RemainAfterExit=', async () => {
    const host = setup({ '/etc/systemd/system/setup.service': '[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStartPre=/bin/pre\nExecStart=/bin/one\nExecStart=/bin/two\nStandardOutput=null\n' })
    host.behaviour = () => ({ code: 0 })
    await host.manager.start('setup.service')
    expect(host.spawned.map(process => process.argv[0])).toEqual(['/bin/pre', '/bin/one', '/bin/two'])
    expect(host.state('setup.service')).toMatchObject({ ActiveState: 'active', SubState: 'exited' })
  })

  it('starts what a unit Requires= first, and fails it when that fails', async () => {
    const host = setup({
      '/etc/systemd/system/app.service': '[Unit]\nRequires=db.service\n[Service]\nExecStart=/bin/app\n',
      '/etc/systemd/system/db.service': '[Service]\nExecStart=/bin/db\n'
    })
    await host.manager.start('app.service')
    expect(host.spawned.map(process => process.argv[4])).toEqual(['/bin/db', '/bin/app'])
    await host.manager.stop('db.service')
    await host.manager.stop('app.service')
    host.behaviour = argv => argv.includes('/bin/db') ? { code: 1 } : undefined
    host.files['/etc/systemd/system/db.service'] = '[Service]\nType=oneshot\nExecStart=/bin/db\n'
    host.manager.reload()
    await host.manager.start('app.service').catch(() => {})
    expect(host.state('app.service')).toMatchObject({ ActiveState: 'failed', Result: 'dependency' })
  })

  it('answers requests as systemctl expects', async () => {
    const host = setup({ '/etc/systemd/system/web.service': '[Service]\nExecStart=/bin/web\n' })
    host.links['/etc/systemd/system/masked.service'] = '/dev/null'
    expect(await host.manager.handle({ id: '1', action: 'start', units: ['web'] })).toEqual({ id: '1', ok: true, errors: [] })
    expect((await host.manager.handle({ id: '2', action: 'start', units: ['nothing'] })).errors).toEqual(['Failed to start nothing.service: Unit nothing.service not found.'])
    expect((await host.manager.handle({ id: '3', action: 'start', units: ['masked'] })).errors).toEqual(['Failed to start masked.service: Unit masked.service is masked.'])
    expect((await host.manager.handle({ id: '4', action: 'reload', units: ['web'] })).errors).toEqual(['Failed to reload web.service: Job type reload is not applicable for unit web.service.'])
  })

  it('starts the units the default target wants at boot, and stops them, last first, at shutdown', async () => {
    const host = setup({
      '/etc/systemd/system/a.service': '[Unit]\nAfter=b.service\n[Service]\nExecStart=/bin/a\n',
      '/etc/systemd/system/b.service': '[Service]\nExecStart=/bin/b\n',
      '/etc/systemd/system/c.service': '[Service]\nExecStart=/bin/c\n'
    })
    host.links['/etc/systemd/system/multi-user.target.wants/a.service'] = '/etc/systemd/system/a.service'
    host.links['/etc/systemd/system/multi-user.target.wants/b.service'] = '/etc/systemd/system/b.service'
    await host.manager.boot(undefined)
    expect(host.spawned.map(process => process.argv[4])).toEqual(['/bin/b', '/bin/a'])
    await host.manager.shutdown()
    expect(host.signals.map(([pid]) => pid)).toEqual([host.spawned[1]!.pid, host.spawned[0]!.pid])
  })
})
