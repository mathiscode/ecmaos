import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The tools a Linux administrator reaches for: `systemctl`, `service` and `journalctl` over the service manager in
 * `/sbin/init`, `crontab` and `at` over crond, and `hostnamectl`, `timedatectl`, `localectl` and `locale`.
 */
describe('administration tools', () => {
  let kernel: Kernel
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }
  const until = async (check: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await check()) return true; await sleep(100) }
    return false
  }
  const unit = (name: string, text: string) => fs().writeFile(`/etc/systemd/system/${name}`, text, { mode: 0o644 })

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    // the service manager publishes its state once init has started the units
    await until(async () => await fs().exists('/run/systemd/state.json'))
  }, 60_000)

  describe('systemctl', () => {
    it('starts, shows and stops a simple service, whose output reaches the journal', async () => {
      await unit('demo.service', '[Unit]\nDescription=A demonstration\n\n[Service]\nExecStart=/bin/ecmash -c "echo hello from demo; sleep 300"\n\n[Install]\nWantedBy=multi-user.target\n')
      expect((await run('systemctl start demo')).code).toBe(0)
      expect((await run('systemctl is-active demo')).out).toBe('active\n')
      expect(await until(async () => (await read('/var/log/messages')).includes('hello from demo'))).toBe(true)
      const status = await run('systemctl status --no-pager demo')
      expect(status.code).toBe(0)
      expect(status.out).toContain('demo.service - A demonstration')
      expect(status.out).toMatch(/Active: active \(running\) since /)
      expect(status.out).toMatch(/Main PID: \d+ \(ecmash\)/)
      expect(status.out).toContain('hello from demo')
      expect((await run('systemctl list-units --no-pager')).out).toMatch(/demo\.service\s+loaded\s+active\s+running\s+A demonstration/)
      expect((await run('systemctl stop demo')).code).toBe(0)
      const stopped = await run('systemctl is-active demo')
      expect(stopped.out).toBe('inactive\n')
      expect(stopped.code).toBe(3)
      expect(await until(async () => /init\[1\]: Stopped demo\.service - A demonstration\./.test((await run('journalctl --no-pager -u demo')).out))).toBe(true)
    }, 60_000)

    it('enables and disables a unit with links in the target\'s .wants', async () => {
      expect((await run('systemctl enable demo.service')).err).toContain("Created symlink '/etc/systemd/system/multi-user.target.wants/demo.service'")
      expect(await fs().readlink('/etc/systemd/system/multi-user.target.wants/demo.service')).toBe('/etc/systemd/system/demo.service')
      expect((await run('systemctl is-enabled demo')).out).toBe('enabled\n')
      expect((await run('systemctl list-unit-files --no-pager demo*')).out).toMatch(/demo\.service\s+enabled/)
      await run('systemctl disable demo')
      const disabled = await run('systemctl is-enabled demo')
      expect(disabled.out).toBe('disabled\n')
      expect(disabled.code).toBe(1)
      // a unit whose file is the administrator's cannot be masked over it; a packaged one can
      expect((await run('systemctl mask demo')).err).toContain('Failed to mask unit: File /etc/systemd/system/demo.service already exists.')
      await fs().writeFile('/lib/systemd/system/packaged.service', '[Service]\nExecStart=/bin/sleep 300\n\n[Install]\nWantedBy=multi-user.target\n')
      await run('systemctl mask packaged')
      expect(await fs().readlink('/etc/systemd/system/packaged.service')).toBe('/dev/null')
      expect((await run('systemctl is-enabled packaged')).out).toBe('masked\n')
      const refused = await run('systemctl start packaged')
      expect(refused.code).toBe(1)
      expect(refused.err).toBe('Failed to start packaged.service: Unit packaged.service is masked.\n')
      await run('systemctl unmask packaged')
      expect((await run('systemctl is-enabled packaged')).out).toBe('disabled\n')
    }, 60_000)

    it('marks a service that exits with an error failed, and restarts one that asks for it', async () => {
      await unit('broken.service', '[Service]\nExecStart=/bin/ecmash -c "exit 3"\n')
      await run('systemctl start broken')
      expect(await until(async () => (await run('systemctl is-failed broken')).out === 'failed\n')).toBe(true)
      expect((await run('systemctl status --no-pager broken')).out).toMatch(/Active: failed \(Result: |Active: failed/)
      expect(await until(async () => (await run('journalctl --no-pager -u broken')).out.includes("broken.service: Failed with result 'exit-code'."))).toBe(true)
      await run('systemctl reset-failed broken')
      expect((await run('systemctl is-failed broken')).code).toBe(1)

      await unit('flaky.service', '[Service]\nExecStart=/bin/ecmash -c "echo run >> /tmp/flaky-runs; sleep 0.2; exit 1"\nRestart=on-failure\nRestartSec=200ms\n')
      await run('systemctl start flaky')
      expect(await until(async () => (await read('/tmp/flaky-runs')).split('\n').length > 3)).toBe(true)
      expect((await run('journalctl --no-pager -u flaky')).out).toMatch(/Scheduled restart job, restart counter is at \d/)
      await run('systemctl stop flaky')
    }, 60_000)

    it('runs a oneshot unit to the end and keeps it active with RemainAfterExit=', async () => {
      await unit('setup.service', '[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/ecmash -c "echo one > /tmp/setup-1"\nExecStart=/bin/ecmash -c "echo two > /tmp/setup-2"\n')
      expect((await run('systemctl start setup')).code).toBe(0)
      expect(await read('/tmp/setup-1')).toBe('one\n')
      expect(await read('/tmp/setup-2')).toBe('two\n')
      expect((await run('systemctl status --no-pager setup')).out).toContain('Active: active (exited)')
      expect((await run('systemctl show -p ActiveState,SubState setup')).out).toBe('ActiveState=active\nSubState=exited\n')
    }, 60_000)

    it('runs as the unit\'s User= with its Environment=', async () => {
      await kernel.users.add({ username: 'svc', password: 'service-pw', home: '/home/svc', shell: '/bin/ecmash' })
      await unit('whoami.service', '[Service]\nType=oneshot\nUser=svc\nEnvironment="GREETING=hi there"\nExecStart=/bin/ecmash -c "id -un > /tmp/whoami-user; echo $GREETING > /tmp/whoami-env"\n')
      const started = await run('systemctl start whoami')
      expect(started.err).toBe('')
      expect(started.code).toBe(0)
      expect((await read('/tmp/whoami-env')).trim()).toBe('hi there')
      if (kernel.programsRunAsUser) expect((await read('/tmp/whoami-user')).trim()).toBe('svc')
    }, 60_000)

    it('refuses what a user may not do, and says what it cannot find', async () => {
      const missing = await run('systemctl status --no-pager nothing-here')
      expect(missing.code).toBe(4)
      expect(missing.err).toContain('Unit nothing-here.service could not be found.')
      expect((await run('systemctl frobnicate')).err).toContain("Unknown command verb 'frobnicate'.")
    })
  })

  describe('service and SysV scripts', () => {
    it('runs an init.d script as a unit, and its own actions directly', async () => {
      await fs().writeFile('/etc/init.d/legacy', '#!/bin/sh\n### BEGIN INIT INFO\n# Short-Description: an old-style service\n### END INIT INFO\ncase "$1" in\n  start) echo started > /tmp/legacy ;;\n  stop) echo stopped > /tmp/legacy ;;\n  status) test -f /tmp/legacy && grep -q started /tmp/legacy && exit 0; exit 3 ;;\n  hello) echo hello from legacy ;;\nesac\n', { mode: 0o755 })
      expect((await run('service legacy start')).code).toBe(0)
      expect(await read('/tmp/legacy')).toBe('started\n')
      expect((await run('systemctl is-active legacy')).out).toBe('active\n')
      expect((await run('systemctl status --no-pager legacy')).out).toContain('legacy.service - LSB: an old-style service')
      expect((await run('service legacy hello')).out).toBe('hello from legacy\n')
      expect((await run('service --status-all')).out).toContain(' [ + ]  legacy')
      await run('service legacy stop')
      expect(await read('/tmp/legacy')).toBe('stopped\n')
      await run('systemctl enable legacy')
      expect(await fs().readlink('/etc/rc3.d/S01legacy')).toBe('../init.d/legacy')
      expect((await run('systemctl is-enabled legacy')).out).toBe('enabled\n')
    }, 60_000)
  })

  describe('journalctl', () => {
    it('filters by identifier, count and kernel, and prints the formats', async () => {
      await run('logger -t journal-test first line')
      await run('logger -t journal-test second line')
      expect(await until(async () => (await read('/var/log/messages')).includes('second line'))).toBe(true)
      const tagged = await run('journalctl --no-pager -t journal-test')
      expect(tagged.out).toMatch(/journal-test: first line\n.*journal-test: second line\n$/)
      expect((await run('journalctl --no-pager -t journal-test -n 1 -o cat')).out).toBe('second line\n')
      expect((await run('journalctl --no-pager -t journal-test -r -n 1 -o cat')).out).toBe('second line\n')
      const json = JSON.parse((await run('journalctl --no-pager -t journal-test -n 1 -o json')).out)
      expect(json).toMatchObject({ MESSAGE: 'second line', SYSLOG_IDENTIFIER: 'journal-test', _TRANSPORT: 'syslog' })
      expect((await run('journalctl --no-pager -k -n 5')).out).toMatch(/ kernel: /)
      expect((await run('journalctl --no-pager -t no-such-tag')).out).toBe('-- No entries --\n')
      expect((await run('journalctl --no-pager -g "^second" -o cat')).out).toContain('second line')
    }, 30_000)
  })

  describe('crontab', () => {
    it('installs, lists and removes a table in the spool, and refuses one with errors', async () => {
      await fs().writeFile('/tmp/table', '# m h dom mon dow command\nMAILTO=""\n*/5 * * * * echo five\n@daily echo daily\n')
      expect((await run('crontab /tmp/table')).code).toBe(0)
      expect(await read('/var/spool/cron/crontabs/root')).toContain('*/5 * * * * echo five')
      expect(((await fs().stat('/var/spool/cron/crontabs/root')).mode & 0o777)).toBe(0o600)
      expect((await run('crontab -l')).out).toContain('@daily echo daily')
      await fs().writeFile('/tmp/bad-table', 'not a schedule at all\n')
      const bad = await run('crontab /tmp/bad-table')
      expect(bad.code).toBe(1)
      expect(bad.err).toContain("errors in crontab file, can't install.")
      expect((await run('crontab -T /tmp/table')).code).toBe(0)
      expect((await run('crontab -r')).code).toBe(0)
      const none = await run('crontab -l')
      expect(none.code).toBe(1)
      expect(none.err).toBe('no crontab for root\n')
    }, 30_000)
  })

  describe('at', () => {
    it('queues a job that crond runs, lists it, and removes one', async () => {
      await fs().writeFile('/tmp/at-job', 'echo at-ran > /tmp/at-out\n')
      const queued = await run('at -f /tmp/at-job now')
      expect(queued.code).toBe(0)
      expect(queued.err).toMatch(/^warning: commands will be executed using \/bin\/sh\njob \d+ at /)
      expect(await until(async () => (await read('/tmp/at-out')) === 'at-ran\n', 20_000)).toBe(true)
      await fs().writeFile('/tmp/at-later', 'echo later\n')
      const later = await run('at -f /tmp/at-later teatime tomorrow')
      const id = /job (\d+)/.exec(later.err)?.[1]
      expect((await run('atq')).out).toMatch(new RegExp(`^${id}\\t.+ a root\\n`, 'm'))
      expect((await run(`at -c ${id}`)).out).toContain('echo later')
      expect((await run(`atrm ${id}`)).code).toBe(0)
      expect((await run('atq')).out).not.toContain(`${id}\t`)
      expect((await run('at -f /tmp/at-later garbled words')).err).toBe('Garbled time\n')
    }, 40_000)
  })

  describe('hostnamectl, timedatectl, localectl, locale', () => {
    it('hostname and uname give the kernel\'s name, and hostnamectl sets it and /etc/hostname', async () => {
      expect((await run('hostname')).out.trim()).toBe((await read('/etc/hostname')).trim())
      expect((await run('hostnamectl set-hostname webbox')).code).toBe(0)
      expect(await read('/etc/hostname')).toBe('webbox\n')
      expect((await run('hostname')).out).toBe('webbox\n')
      expect((await run('uname -n')).out).toBe('webbox\n')
      const status = await run('hostnamectl')
      expect(status.out).toMatch(/Static hostname: webbox/)
      expect(status.out).toMatch(/Operating System: ecmaOS/)
      expect((await run('hostnamectl set-hostname "My Web Box"')).code).toBe(0)
      expect((await run('hostname')).out).toBe('my-web-box\n')
      expect((await run('hostnamectl --pretty hostname')).out).toBe('My Web Box\n')
    })

    it('timedatectl shows the clock and sets the zone the programs started afterwards use', async () => {
      expect((await run('timedatectl')).out).toMatch(/Time zone: \S+ \(\S+, [+-]\d{4}\)/)
      expect((await run('timedatectl set-timezone Asia/Tokyo')).code).toBe(0)
      expect(await read('/etc/timezone')).toBe('Asia/Tokyo\n')
      expect((await run('date +%z')).out).toBe('+0900\n')
      expect((await run('timedatectl')).out).toContain('Time zone: Asia/Tokyo (')
      expect((await run('timedatectl list-timezones')).out).toContain('Europe/Paris\n')
      expect((await run('timedatectl set-timezone Nowhere/Special')).err).toContain("Invalid or not installed time zone 'Nowhere/Special'")
      expect((await run('timedatectl set-time "2020-01-01"')).code).toBe(1)
      expect((await run('TZ=America/New_York date +%Z')).out).toMatch(/^E[SD]T\n$/)
    })

    it('localectl sets LANG in /etc/default/locale and locale shows what is in effect', async () => {
      expect((await run('localectl set-locale LANG=de_DE.UTF-8')).code).toBe(0)
      expect(await read('/etc/default/locale')).toBe('LANG=de_DE.UTF-8\n')
      expect((await run('localectl')).out).toContain('System Locale: LANG=de_DE.UTF-8')
      expect((await run('localectl set-locale LANG=xx_YY.UTF-8')).err).toContain('Locale xx_YY.UTF-8 not installed, refusing.')
      expect((await run('locale -a')).out).toContain('en_US.utf8\n')
      expect((await run('LANG=en_US.UTF-8 locale')).out).toContain('LC_TIME="en_US.UTF-8"')
      expect((await run('LANG=en_US.UTF-8 locale charmap')).out).toBe('UTF-8\n')
    })
  })
})
