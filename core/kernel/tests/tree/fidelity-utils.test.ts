import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** envsubst, stdbuf, taskset, ionice, getopt, dircolors, reset and chpasswd */
describe('small tools for scripts', () => {
  let kernel: Kernel
  let serial = 0
  const fs = () => kernel.filesystem.fs
  const sh = async (command: string) => {
    const base = `/tmp/fu-${serial++}`
    const code = await kernel.shell.execute(`${command} > ${base}.out 2> ${base}.err`)
    const read = (suffix: string) => fs().readFile(`${base}.${suffix}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60_000)

  it('envsubst fills in variables, only the ones a format names when given one, and lists them with -v', async () => {
    const all = await sh(`GREETING=hello NAME=world envsubst <<< 'say $GREETING, \${NAME}! $MISSING.'`)
    expect(all.err).toBe('')
    expect(all.out).toBe('say hello, world! .\n')
    const some = await sh(`GREETING=hello NAME=world envsubst '$NAME' <<< 'say $GREETING, \${NAME}!'`)
    expect(some.out).toBe('say $GREETING, world!\n')
    expect((await sh(`envsubst -v 'a $ONE and \${TWO} and $ONE'`)).out).toBe('ONE\nTWO\n')
    expect((await sh('envsubst -v')).code).toBe(1)
  })

  it('stdbuf, taskset and ionice run the command, and check what they are given', async () => {
    expect((await sh('stdbuf -oL echo through')).out).toBe('through\n')
    expect((await sh('stdbuf -o junk echo x')).err).toMatch(/invalid mode/)
    expect((await sh('stdbuf echo x')).code).toBe(125)
    expect((await sh('taskset -c 0 echo pinned')).out).toBe('pinned\n')
    expect((await sh('taskset -c 9999 echo x')).code).toBe(1)
    expect((await sh('taskset -p 1')).out).toMatch(/^pid 1's current affinity mask: [0-9a-f]+\n$/)
    expect((await sh('ionice -c 3 echo idle')).out).toBe('idle\n')
    expect((await sh('ionice -p 1')).out).toBe('none: prio 0\n')
    expect((await sh('ionice -c 9 echo x')).code).toBe(1)
  })

  it('getopt normalizes a command line the way scripts eval it', async () => {
    expect((await sh("getopt -o ab:c:: -l all,out:,opt:: -- -a -bvalue file1 --out=x -cattached --opt file2")).out)
      .toBe(" -a -b 'value' --out 'x' -c 'attached' --opt '' -- 'file1' 'file2'\n")
    expect((await sh("getopt ab: -a -b 'two words' rest")).out).toBe(" -a -b 'two words' -- 'rest'\n")
    expect((await sh("getopt -u -o a -- -a x")).out).toBe(' -a -- x\n')
    const bad = await sh("getopt -n prog -o a -- -z")
    expect(bad.code).toBe(1)
    expect(bad.err).toBe("prog: invalid option -- 'z'\n")
    expect(bad.out).toBe(' --\n')
    expect((await sh('getopt -T')).code).toBe(4)
    expect((await sh("eval set -- \"$(getopt -o x: -- -x 'a b' c)\"; for arg in \"$@\"; do echo \"[$arg]\"; done")).out).toBe('[-x]\n[a b]\n[--]\n[c]\n')
  })

  it('dircolors prints LS_COLORS for a shell, from the built-in database or a file', async () => {
    const built = await sh('TERM=xterm dircolors -b')
    expect(built.out).toMatch(/^LS_COLORS='rs=0:di=01;34:ln=01;36:.*\*\.tar=01;31.*:';\nexport LS_COLORS\n$/)
    expect((await sh('TERM=xterm dircolors -c')).out).toMatch(/^setenv LS_COLORS 'rs=0:/)
    await fs().writeFile('/tmp/mycolors', 'TERM *\nDIR 01;33 # yellow\n.rs 00;32\n')
    expect((await sh('dircolors -b /tmp/mycolors')).out).toBe("LS_COLORS='di=01;33:*.rs=00;32:';\nexport LS_COLORS\n")
    expect((await sh('TERM=dumb dircolors -b')).out).toBe("LS_COLORS='';\nexport LS_COLORS\n")
    expect((await sh('dircolors -p')).out).toContain('DIR 01;34')
    await fs().writeFile('/tmp/badcolors', 'NOSUCH 01\n')
    expect((await sh('dircolors /tmp/badcolors')).err).toBe('dircolors: unrecognized keyword NOSUCH\n')
  })

  it('reset sends the sequence that restores the terminal', async () => {
    const result = await sh('reset')
    expect(result.code).toBe(0)
    expect(result.out.startsWith('\x1bc')).toBe(true)
    expect(result.out.endsWith('\x1b[?25h\x1b[0m')).toBe(true)
  })

  it('chpasswd sets the passwords on its input lines, and says which line it could not', async () => {
    await kernel.users.add({ username: 'bulk1', password: 'first-old', home: '/home/bulk1', shell: '/bin/ecmash' })
    await kernel.users.add({ username: 'bulk2', password: 'second-old', home: '/home/bulk2', shell: '/bin/ecmash' })
    const done = await sh("printf 'bulk1:first-new\\nbulk2:second-new!\\n' | chpasswd")
    expect(done.code, done.err).toBe(0)
    expect(done.out + done.err).toBe('')
    expect(await kernel.users.login('bulk1', 'first-new')).toBeTruthy()
    expect(await kernel.users.login('bulk2', 'second-new!')).toBeTruthy()
    await expect(kernel.users.login('bulk1', 'first-old')).rejects.toThrow()
    const bad = await sh("printf 'bulk1\\nnobody-here:x\\n' | chpasswd")
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('line 1: missing new password')
    expect(bad.err).toContain('line 2:')
    expect((await sh("echo 'a:b' | chpasswd -e")).err).toContain('not supported')
  }, 30_000)
})
