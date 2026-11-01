import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** Small differences from bash that scripts run into: where the shell's own errors go, traps, `set`, `export`, `time`. */
describe('shell polish', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  /** Runs `script` with its standard output in a file and gives back the file's text */
  async function run(name: string, script: string): Promise<string> {
    const path = `/tmp/polish-${name}.sh`
    const out = `/tmp/polish-${name}.out`
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\nexec > ${out}\n${script}\nexec > /dev/null\n`)
    await kernel.execute({ command: path, shell: kernel.shell })
    return await kernel.filesystem.fs.exists(out) ? await kernel.filesystem.fs.readFile(out, 'utf-8') as unknown as string : '<missing>'
  }

  describe('the shell\'s own errors', () => {
    it('follow a 2> on the command that was not found', async () => {
      const text = await run('nf-file', 'nosuchcmd 2> /tmp/polish-nf.err; echo st=$?; cat /tmp/polish-nf.err')
      expect(text).toContain('st=127')
      expect(text).toContain('nosuchcmd: command not found')
    })

    it('follow > file 2>&1', async () => {
      const text = await run('nf-dup', 'nosuchcmd > /tmp/polish-nf2.err 2>&1; cat /tmp/polish-nf2.err')
      expect(text).toContain('nosuchcmd: command not found')
    })

    it('are not shown when 2>/dev/null', async () => {
      expect(await run('nf-null', 'nosuchcmd 2>/dev/null; echo st=$?')).toBe('st=127\n')
    })
  })

  describe('traps', () => {
    it('runs a subshell\'s own EXIT trap as it ends', async () => {
      expect(await run('trap-sub', '( trap "echo trapped" EXIT; echo body )\necho after')).toBe('body\ntrapped\nafter\n')
    })

    it('does not run the parent\'s EXIT trap in a subshell', async () => {
      const text = await run('trap-parent', 'trap "echo parent >> /tmp/polish-tp.log" EXIT\n( echo sub )\necho main')
      expect(text).toBe('sub\nmain\n')
      expect(await kernel.filesystem.fs.readFile('/tmp/polish-tp.log', 'utf-8')).toBe('parent\n')
    })
  })

  describe('set and export', () => {
    it('lists the options bash lists, in its format', async () => {
      const text = await run('seto', 'set -o')
      expect(text).toContain('allexport      \toff\n')
      expect(text).toContain('braceexpand    \ton\n')
      expect(text).toContain('posix          \toff\n')
      expect(text).toContain('vi             \toff\n')
      expect(text.trim().split('\n')).toHaveLength(27)
    })

    it('accepts posix, vi and emacs, and keeps the editors exclusive', async () => {
      const text = await run('seto2', 'set -o posix; echo p=$?\nset -o vi; set -o emacs\nset -o | grep -E "^(posix|vi|emacs)"')
      expect(text).toContain('p=0')
      expect(text).toMatch(/emacs\s+on/)
      expect(text).toMatch(/vi\s+off/)
    })

    it('prints what set +o would restore', async () => {
      expect(await run('setplus', 'set +o | grep -E "noclobber|errexit"')).toBe('set +o errexit\nset +o noclobber\n')
    })

    it('exports every assignment under set -a', async () => {
      const text = await run('allexport', 'set -a\nPOLISH_A=1\nset +a\nPOLISH_B=2\nexport -p | grep POLISH')
      expect(text).toBe('declare -x POLISH_A="1"\n')
    })

    it('prints export -p as declare -x, quoting the value', async () => {
      expect(await run('exportp', 'export POLISH_Q=\'a "b" $c\'\nexport -p | grep POLISH_Q')).toBe('declare -x POLISH_Q="a \\"b\\" \\$c"\n')
    })

    it('takes export -f for a function and refuses a name that is not one', async () => {
      expect(await run('exportf', 'f() { echo hi; }\nexport -f f; echo a=$?\nexport -f nope 2>/dev/null; echo b=$?')).toBe('a=0\nb=1\n')
    })

    it('shows the flags in $-', async () => {
      const text = await run('flags', 'set -a\necho $-')
      expect(text.trim()).toMatch(/^a.*h.*B.*i/)
    })
  })

  describe('time', () => {
    it('reports in the form bash does', async () => {
      const text = await run('time', 'time true 2> /tmp/polish-time.err; cat /tmp/polish-time.err')
      expect(text).toMatch(/real\t\d+m\d+\.\d{3}s/)
      expect(text).toMatch(/sys\t0m0\.000s/)
    })
  })

  describe('the terminal environment', () => {
    it('has a terminfo name curses programs know, and no unexpanded $HOME in PATH', async () => {
      const text = await run('env', 'echo "$TERM"; echo "$PATH"')
      const [term, searchPath] = text.split('\n')
      expect(term).toBe('xterm-256color')
      expect(searchPath).not.toContain('$HOME')
      expect(searchPath).toContain('/bin')
    })
  })

  describe('commands', () => {
    it('git --version answers', async () => {
      expect(await run('gitver', 'git --version')).toMatch(/^git version \d/)
    })

    it('ls /proc/self/fd lists the descriptors without an error', async () => {
      const path = '/tmp/polish-procfd.sh'
      await kernel.filesystem.fs.writeFile(path, '#!ecmaos:bin:script:test\nls /proc/self/fd > /tmp/polish-procfd.out 2> /tmp/polish-procfd.err\necho st=$? >> /tmp/polish-procfd.out\n')
      await kernel.execute({ command: path, shell: kernel.shell })
      expect(await kernel.filesystem.fs.readFile('/tmp/polish-procfd.err', 'utf-8')).toBe('')
      expect(await kernel.filesystem.fs.readFile('/tmp/polish-procfd.out', 'utf-8')).toMatch(/^0\n1\n2\n(3\n)?st=0\n$/)
    })
  })
})
