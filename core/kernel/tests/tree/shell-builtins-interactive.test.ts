import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The builtins an interactive user reaches for that are not about scripting: `help`, `hash`, `times`,
 * `logout`, `fc`, and `PROMPT_COMMAND`. The directory stack and `select` are checked against real bash
 * by the parity corpus; what lives here is what bash can only show on a terminal.
 */
describe('interactive builtins', () => {
  let kernel: Kernel
  let serial = 0

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  const shell = () => kernel.shell
  const fs = () => kernel.filesystem.fs

  beforeEach(() => {
    shell().state.dirStack = []
    shell().env.delete('PROMPT_COMMAND')
  })

  /** Runs `script` and returns what it wrote to stdout and to stderr. */
  const run = async (script: string): Promise<{ out: string, err: string, status: number }> => {
    const base = `/tmp/ib-${serial++}`
    const status = await shell().executeScriptText(`exec > ${base}.out 2> ${base}.err; ${script}`, `${base}.sh`)
    const read = (file: string) => fs().readFile(file, 'utf-8').catch(() => '')
    return { out: await read(`${base}.out`), err: await read(`${base}.err`), status }
  }

  it('help describes a builtin, lists topics by pattern, and refuses an unknown one', async () => {
    const one = await run('help pushd')
    expect(one.out).toContain('pushd: pushd [-n] [+N | -N | DIR]')

    const short = await run('help -d cd; help -s cd')
    expect(short.out).toBe('cd - Change the shell working directory.\ncd: cd [DIR]\n')

    const none = await run('help nosuchbuiltin')
    expect(none.status).toBe(1)
    expect(none.err).toContain('no help topics match `nosuchbuiltin\'')

    expect((await run('help >/dev/null; echo $?')).out).toBe('0\n')
    expect((await run('help nosuchbuiltin 2>/dev/null; echo $?')).out).toBe('1\n')
  })

  it('hash remembers nothing and says so, but checks that a name can be found', async () => {
    expect((await run('hash')).out).toBe('hash: hash table empty\n')
    expect((await run('hash ls; echo $?; hash nosuchthing 2>/dev/null; echo $?')).out).toBe('0\n1\n')
    expect((await run('hash -p /bin/ls ls; echo $?')).out).toBe('1\n')
  })

  it('times says plainly that there is no CPU accounting', async () => {
    const result = await run('times; echo $?')
    expect(result.out).toBe('1\n')
    expect(result.err).toContain('times: not available')
  })

  it('logout ends a login shell with the given status', async () => {
    const result = await run('logout 3; echo not reached')
    expect(result.out).toBe('')
    expect(result.status).toBe(3)
  })

  it('fc lists, re-runs and substitutes from the history file', async () => {
    await fs().writeFile('/root/.ecmash_history', 'echo one\necho two\nfc -l\n')
    const listed = await run('fc -l; fc -ln 1 1; fc -lr')
    expect(listed.out).toBe('1\t echo one\n2\t echo two\n\t echo one\n2\t echo two\n1\t echo one\n')

    const again = await run('fc -s two=2 echo')
    expect(again.out).toBe('echo 2\n2\n')

    const missing = await run('fc -s nothing')
    expect(missing.err).toContain('fc: no command found')
    expect(missing.status).toBe(1)
  })

  it('fc edits through the editor named by -e and runs what comes back', async () => {
    await fs().writeFile('/root/.ecmash_history', 'echo one\nfc\n')
    // `cp SOURCE` is the "editor": it is handed the scratch file as its last word and overwrites it
    const result = await run('echo "echo edited" > /tmp/fc-edit-result; fc -e "cp /tmp/fc-edit-result"')
    expect(result.out).toBe('echo edited\nedited\n')
  })

  it('PROMPT_COMMAND runs before the prompt, scalar or array, and leaves $? alone', async () => {
    await shell().execute('false')
    await shell().executeScriptText('PROMPT_COMMAND=\'PROMPT_RAN="${PROMPT_RAN}x"; true\'', '/tmp/pc.sh')
    expect(shell().hasPromptCommand()).toBe(true)
    await shell().execute('false')
    await shell().runPromptCommand()
    expect(shell().env.get('PROMPT_RAN')).toBe('x')
    expect(shell().env.get('?')).toBe('1')

    await shell().executeScriptText('unset PROMPT_COMMAND; PROMPT_COMMAND=(\'PROMPT_RAN=a\' \'PROMPT_RAN="${PROMPT_RAN}b"\')', '/tmp/pc2.sh')
    await shell().runPromptCommand()
    expect(shell().env.get('PROMPT_RAN')).toBe('ab')

    await shell().executeScriptText('unset PROMPT_COMMAND', '/tmp/pc3.sh')
    expect(shell().hasPromptCommand()).toBe(false)
  })

  it('the directory stack follows pushd, popd and DIRSTACK', async () => {
    await fs().mkdir('/tmp/ds/a', { recursive: true })
    const result = await run('cd /tmp/ds; pushd a >/dev/null; echo "${DIRSTACK[@]}"; popd >/dev/null; pwd')
    expect(result.out).toBe('/tmp/ds/a /tmp/ds\n/tmp/ds\n')
  })

  it('select reads its choice from a redirected file and reprints nothing when the reply is valid', async () => {
    await fs().writeFile('/tmp/select-input', '2\n')
    const result = await run('select x in one two three; do echo "$x"; break; done < /tmp/select-input 2>/dev/null')
    expect(result.out).toBe('two\n')
  })

  it('tr reads backslash escapes and character classes in its sets', async () => {
    const result = await run("printf 'a\\tb\\nc\\n' | tr '\\t\\n' '_-'; echo; echo Hello | tr '[:lower:]' '[:upper:]'; echo a-b | tr 'a\\-' 'xy'")
    expect(result.out).toBe('a_b-c-\nHELLO\nxyb\n')
  })

  it('ulimit reports the real limits, accepts what is already true, and refuses the rest', async () => {
    const { currentStorageLimits } = await import('#lib/storage-limits.ts')
    const cap = currentStorageLimits().maxFileBytes as number
    expect((await run('ulimit; ulimit -f; ulimit -n; ulimit -c')).out).toBe(`${cap / 1024}\n${cap / 1024}\nunlimited\n0\n`)

    const all = (await run('ulimit -a')).out.split('\n')
    expect(all).toContain(`file size                   (blocks, -f) ${cap / 1024}`)
    expect(all).toContain('open files                          (-n) unlimited')
    expect(all).toContain('pipe size                (512 bytes, -p) 8')

    expect((await run('ulimit -c 0; echo $?; ulimit -n unlimited; echo $?; ulimit -Hf; ulimit -f -n')).out)
      .toBe(`0\n0\n${cap / 1024}\nfile size                   (blocks, -f) ${cap / 1024}\nopen files                          (-n) unlimited\n`)

    const lower = await run('ulimit -n 1024; echo $?')
    expect(lower.out).toBe('1\n')
    expect(lower.err).toContain('open files: cannot lower the limit')
    const raise = await run('ulimit -f unlimited; echo $?')
    expect(raise.err).toContain('file size: cannot modify limit: Operation not permitted')
    expect((await run('ulimit -f banana; echo $?')).err).toContain('banana: invalid number')
    expect((await run('ulimit -z; echo $?')).out).toBe('2\n')
  })

  it('ulimit in /bin/ecmash asks the kernel for the same file size cap', async () => {
    const { currentStorageLimits } = await import('#lib/storage-limits.ts')
    const cap = currentStorageLimits().maxFileBytes as number
    await shell().execute('ecmash -c \'ulimit -f; ulimit -n; ulimit -n 5; echo $?\' > /tmp/ul-ecmash 2>/dev/null')
    expect(await fs().readFile('/tmp/ul-ecmash', 'utf-8')).toBe(`${cap / 1024}\nunlimited\n1\n`)
  })

  it('ls and grep color on request, stay plain in a pipe under auto, and the skel aliases use auto', async () => {
    await fs().mkdir('/tmp/colors/dir', { recursive: true })
    await fs().chmod('/tmp/colors/dir', 0o755)
    await fs().writeFile('/tmp/colors/notes.txt', 'alpha beta\nbeta gamma\n')
    // eslint-disable-next-line no-control-regex
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[mK]/g, '')

    const listed = await run('cd /tmp/colors; ls --color=always; ls --color=auto | cat; ls -l --color=always')
    expect(listed.out).toContain('\x1b[01;34mdir\x1b[0m')
    // the plain `.txt` shows once uncolored under `always`, and both names are plain through the pipe
    expect(listed.out.split('\n').filter(line => line === 'dir' || line === 'notes.txt')).toEqual(['notes.txt', 'dir', 'notes.txt'])
    expect(listed.out).toMatch(/ \x1b\[01;34mdir\x1b\[0m\n/)

    const found = await run('cd /tmp/colors; grep --color=always -n beta notes.txt; grep --color=auto beta notes.txt | cat')
    expect(found.out).toContain('\x1b[32m\x1b[K1\x1b[m\x1b[K\x1b[36m\x1b[K:\x1b[m\x1b[K')
    expect(found.out).toContain('alpha \x1b[01;31m\x1b[Kbeta\x1b[m\x1b[K')
    expect(strip(found.out)).toBe('1:alpha beta\n2:beta gamma\nalpha beta\nbeta gamma\n')

    expect((await run('ls --color=sometimes; echo $?')).err).toContain("invalid argument 'sometimes' for '--color'")
    expect(await fs().readFile('/etc/skel/.bashrc', 'utf-8')).toContain("alias ls='ls --color=auto'")
  })
})
