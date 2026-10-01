import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Variable scoping and the boundary between a shell's own state and a child process's environment.
 *
 * Four confirmed bugs, all in the same area:
 *
 * - `export` and `unset` called `shell.env` directly, bypassing `local` frames entirely. So
 *   `local X=1; export X=2` left the local shadowing `X` at 1 and destroyed the *caller's* `X`, and
 *   `unset X` on a local could not remove it at all -- the frame kept shadowing the name while the
 *   global went away.
 * - `env` and `export -p` read `shell.env` too, so inside a function they listed the caller's values
 *   rather than what was actually visible.
 * - `envObject`, which is every child process's `envp`, was the environment map wholesale. Every
 *   command therefore started with `?=0` in its environment, and a script's positional parameters
 *   arrived as `0=/bin/foo`, `1=arg`.
 * - `globalThis.process.env` is one global object and ecmaOS runs a shell per virtual console, so
 *   every shell wrote to it and whichever logged in last decided what `$PATH` the others saw.
 */
describe('variable scoping and the environment boundary', () => {
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

  const OUT = '/tmp/var-scope.out'

  beforeEach(async () => {
    try { await kernel.filesystem.fs.unlink(OUT) } catch { /* already absent */ }
  })

  async function runScript(script: string): Promise<{ code: number, output: string }> {
    const path = '/tmp/var-scope.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    const code = await kernel.execute({ command: path, shell: kernel.shell })
    const output = await kernel.filesystem.fs.exists(OUT)
      ? await kernel.filesystem.fs.readFile(OUT, 'utf-8') as unknown as string
      : ''
    return { code, output }
  }

  const lines = (output: string): string[] => output.split('\n').filter(line => line !== '')

  describe('export inside a function', () => {
    it('writes the local, not the caller’s variable', async () => {
      const { output } = await runScript([
        'OUTER=original',
        'f() {',
        '  local OUTER=localvalue',
        '  export OUTER=exported',
        `  echo "inside=$OUTER" >> ${OUT}`,
        '}',
        'f',
        `echo "after=$OUTER" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['inside=exported', 'after=original'])
    })

    it('still reaches the real environment at the top level', async () => {
      const { output } = await runScript([
        'export TOP_LEVEL=visible',
        `echo "$TOP_LEVEL" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['visible'])
    })

    it('lists what is visible, including a local shadow', async () => {
      const { output } = await runScript([
        'export SHADOWED=outer',
        'f() {',
        '  local SHADOWED=inner',
        `  export -p >> ${OUT}`,
        '}',
        'f'
      ].join('\n'))
      expect(output).toContain('SHADOWED=inner')
      expect(output).not.toContain('SHADOWED=outer')
    })
  })

  describe('unset inside a function', () => {
    it('removes the local and leaves the caller’s value alone', async () => {
      // bash keeps the outer value hidden for the rest of the call, which is why `inside` is empty
      // rather than `original`: the frame still shadows the name, it just resolves to nothing now.
      const { output } = await runScript([
        'KEEP=original',
        'f() {',
        '  local KEEP=localvalue',
        '  unset KEEP',
        `  echo "inside=[$KEEP]" >> ${OUT}`,
        '}',
        'f',
        `echo "after=[$KEEP]" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['inside=[]', 'after=[original]'])
    })

    it('removes a real variable at the top level', async () => {
      const { output } = await runScript([
        'GONE=here',
        'unset GONE',
        `echo "[$GONE]" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['[]'])
    })

    it('unsets a variable rather than a same-named function', async () => {
      const { output } = await runScript([
        'both() { echo function-survived; }',
        'both=variable',
        'unset both',
        `both >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['function-survived'])
    })

    it('removes a function with -f', async () => {
      const { code } = await runScript([
        'doomed() { echo nope; }',
        'unset -f doomed',
        'doomed'
      ].join('\n'))
      expect(code).not.toBe(0)
    })

    it('still removes arrays and array elements', async () => {
      const { output } = await runScript([
        'arr=(a b c)',
        'unset arr[1]',
        `echo "count=${'${#arr[@]}'}" >> ${OUT}`,
        'unset arr',
        `echo "after=${'${#arr[@]}'}" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['count=2', 'after=0'])
    })
  })

  describe('an assignment that is not the first thing on the line', () => {
    it('assigns after a `;` following an ordinary command', async () => {
      // Found in a browser. `tryExecuteAssignment` only ever looked at the head of a line and handled
      // a trailing assignment by recursing into the remainder -- which never happened when the head
      // was a command, so `zz=5` reached the pipeline path and failed as a command not found.
      const { output } = await runScript([
        `echo one >> ${OUT}`,
        'zz=5',
        `echo z=$zz >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['one', 'z=5'])
    })

    it('assigns mid-line, which is the form a one-line function body uses', async () => {
      const { output } = await runScript([
        `k() { local v; v=42; echo v=$v >> ${OUT}; }`,
        'k'
      ].join('\n'))
      expect(lines(output)).toEqual(['v=42'])
    })

    it('handles an array literal mid-line', async () => {
      // The reason this works on raw text rather than the parsed pipeline: `arr=(a b)` tokenizes into
      // the two words `arr=(a` and `b)`, so there is no assignment left to recognize by then.
      const { output } = await runScript([
        `m() { local arr; arr=(x y z); echo n=${'${#arr[@]}'} first=${'${arr[0]}'} >> ${OUT}; }`,
        'm'
      ].join('\n'))
      expect(lines(output)).toEqual(['n=3 first=x'])
    })

    it('honors && and || before the assignment', async () => {
      const { output } = await runScript([
        'a=unset',
        'b=unset',
        'false && a=ran',
        'false || b=ran',
        `echo "a=$a b=$b" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['a=unset b=ran'])
    })

    it('leaves a command-prefix assignment alone', async () => {
      // `X=1 cmd` is a command carrying a prefix, not a bare assignment: the value must be scoped to
      // that command and gone afterwards.
      const { output } = await runScript([
        'PFX=outer',
        `echo start >> ${OUT}`,
        `PFX=inner env >> ${OUT}`,
        `echo after=$PFX >> ${OUT}`
      ].join('\n'))
      expect(output).toContain('PFX=inner')
      expect(lines(output).at(-1)).toBe('after=outer')
    })

    it('still runs an ordinary `;` list with no assignment in it', async () => {
      const { output } = await runScript([`echo a >> ${OUT}; echo b >> ${OUT}; echo c >> ${OUT}`].join('\n'))
      expect(lines(output)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('bare local declares without setting', () => {
    it('leaves the name unset, not set to empty', async () => {
      // bash distinguishes the two: `local X` declares X and leaves it unset, `local X=` sets it to
      // empty. `declareLocal` used to default to `''`, which made `${X+set}` claim it was set and
      // `${#arr[@]}` count a declared-but-empty name as one element.
      const { output } = await runScript([
        'f() {',
        '  local DECLARED',
        '  local ASSIGNED=',
        `  echo "declared=[${'${DECLARED+set}'}] assigned=[${'${ASSIGNED+set}'}]" >> ${OUT}`,
        '}',
        'f'
      ].join('\n'))
      expect(lines(output)).toEqual(['declared=[] assigned=[set]'])
    })

    it('still expands as empty and still shadows the caller', async () => {
      const { output } = await runScript([
        'SHADOW=outer',
        'f() {',
        '  local SHADOW',
        `  echo "inside=[$SHADOW]" >> ${OUT}`,
        '}',
        'f',
        `echo "after=[$SHADOW]" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['inside=[]', 'after=[outer]'])
    })
  })

  describe('local covers arrays', () => {
    it('keeps a function\u2019s array out of its caller\u2019s', async () => {
      // `local` used to cover scalars only, so every array was shell-global wherever it was assigned
      // and a function building up `arr` silently overwrote its caller's.
      const { output } = await runScript([
        'arr=(outer1 outer2)',
        'f() {',
        '  local arr',
        '  arr=(inner)',
        `  echo "inside=${'${arr[0]}'} count=${'${#arr[@]}'}" >> ${OUT}`,
        '}',
        'f',
        `echo "after=${'${arr[0]}'} count=${'${#arr[@]}'}" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['inside=inner count=1', 'after=outer1 count=2'])
    })

    it('hides the caller\u2019s array from the moment it is declared', async () => {
      const { output } = await runScript([
        'arr=(a b c)',
        'f() {',
        '  local arr',
        `  echo "count=${'${#arr[@]}'}" >> ${OUT}`,
        '}',
        'f'
      ].join('\n'))
      expect(lines(output)).toEqual(['count=0'])
    })

    it('lets a recursive function keep its own array', async () => {
      const { output } = await runScript([
        'walk() {',
        '  local arr',
        '  arr=($1)',
        '  if test "$1" = outer; then',
        '    walk inner',
        '  fi',
        `  echo "${'${arr[0]}'}" >> ${OUT}`,
        '}',
        'walk outer'
      ].join('\n'))
      expect(lines(output)).toEqual(['inner', 'outer'])
    })

    it('still writes the shell\u2019s own array when nothing declared it local', async () => {
      const { output } = await runScript([
        'arr=(start)',
        'f() {',
        '  arr=(changed)',
        '}',
        'f',
        `echo "${'${arr[0]}'}" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['changed'])
    })

    it('appends and indexes into the local, not the global', async () => {
      const { output } = await runScript([
        'arr=(g)',
        'f() {',
        '  local arr',
        '  arr=(x)',
        '  arr+=(y)',
        '  arr[5]=z',
        `  echo "${'${arr[0]}${arr[1]}${arr[5]}'}" >> ${OUT}`,
        '}',
        'f',
        `echo "after=${'${arr[0]}'} count=${'${#arr[@]}'}" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['xyz', 'after=g count=1'])
    })

    it('unsets the local array without touching the caller\u2019s', async () => {
      const { output } = await runScript([
        'arr=(kept)',
        'f() {',
        '  local arr',
        '  arr=(temp)',
        '  unset arr',
        `  echo "inside=${'${#arr[@]}'}" >> ${OUT}`,
        '}',
        'f',
        `echo "after=${'${arr[0]}'}" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['inside=0', 'after=kept'])
    })
  })

  describe('env inside a function', () => {
    it('lists the local value, not the caller’s', async () => {
      const { output } = await runScript([
        'export LISTED=outer',
        'f() {',
        '  local LISTED=inner',
        `  env >> ${OUT}`,
        '}',
        'f'
      ].join('\n'))
      expect(output).toContain('LISTED=inner')
      expect(output).not.toContain('LISTED=outer')
    })
  })

  describe('what a child process receives', () => {
    it('does not pass $? as an environment variable', async () => {
      // `envObject` used to be the whole environment map, so every command started with `?=0` set.
      const { output } = await runScript([`env >> ${OUT}`].join('\n'))
      expect(lines(output).some(line => line.startsWith('?='))).toBe(false)
    })

    it('does not pass positional parameters as environment variables', async () => {
      const { output } = await runScript([
        'f() {',
        `  env >> ${OUT}`,
        '}',
        'f one two'
      ].join('\n'))
      const names = lines(output).map(line => line.split('=')[0])
      expect(names.filter(name => /^\d+$/.test(name ?? ''))).toEqual([])
    })

    it('still passes the variables a command actually needs', async () => {
      const { output } = await runScript([`env >> ${OUT}`].join('\n'))
      expect(output).toContain('PATH=')
      expect(output).toContain('HOME=')
    })

    it('exposes $? and the positional parameters to expansion all the same', async () => {
      const { output } = await runScript([
        'f() {',
        '  false',
        `  echo "code=$? one=$1" >> ${OUT}`,
        '}',
        'f alpha'
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1 one=alpha'])
    })
  })

  describe('process.env across virtual consoles', () => {
    // `createShell` mounts into a real per-TTY container, so TTY 1 needs one before it can exist.
    beforeAll(() => {
      const container = document.createElement('div')
      container.id = 'terminal-tty1'
      document.body.appendChild(container)
    })

    it('is owned by one shell, so a second shell does not overwrite it', async () => {
      // Shell 0's TTY is the active one at boot, so it owns the mirror. Creating shell 1 (which
      // `switchTty` does) must not repoint `process.env` at the new shell while TTY 0 is still active.
      kernel.shell.env.set('OWNER_MARKER', 'tty0')
      kernel.shell.publishEnv()
      expect(globalThis.process.env['OWNER_MARKER']).toBe('tty0')

      const second = await kernel.createShell(1)
      expect(second).not.toBe(kernel.shell)

      second.env.set('OWNER_MARKER', 'tty1')
      second.publishEnv()
      expect(globalThis.process.env['OWNER_MARKER']).toBe('tty0')
    })

    it('follows ownership when it is handed over', async () => {
      const second = await kernel.createShell(1)
      second.env.set('HANDOVER', 'second')
      second.claimProcessEnv()
      expect(globalThis.process.env['HANDOVER']).toBe('second')

      kernel.shell.env.set('HANDOVER', 'first')
      kernel.shell.claimProcessEnv()
      expect(globalThis.process.env['HANDOVER']).toBe('first')
    })

    it('never mirrors the shell’s own internal state', async () => {
      kernel.shell.env.set('?', '7')
      kernel.shell.setPositionalParameters(['zero', 'one'])
      kernel.shell.claimProcessEnv()
      expect(globalThis.process.env['?']).toBeUndefined()
      expect(globalThis.process.env['1']).toBeUndefined()
      kernel.shell.clearPositionalParameters()
    })
  })
})
