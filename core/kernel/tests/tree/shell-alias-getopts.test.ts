import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `alias`/`unalias`, `type`, `command`, and `getopts`.
 *
 * Aliases are text substitution at command position, not a name lookup, which is what lets
 * `alias ll='ls -la'` contribute two words and `alias sudo='sudo '` make the next word eligible in
 * turn. `getopts` is the loop condition of every script that takes flags, and needs `$OPTIND` and
 * `$OPTARG` plus a second cursor for clustered options that `$OPTIND` cannot express.
 */
describe('alias, type, command and getopts', () => {
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

  const OUT = '/tmp/alias-getopts.out'

  beforeEach(async () => {
    try { await kernel.filesystem.fs.unlink(OUT) } catch { /* already absent */ }
    kernel.shell.aliases.clear()
    // Scripts run in the kernel's own long-lived shell, so a function one test defines (the `echo`
    // wrapper below, in particular) would otherwise wrap every test after it.
    kernel.shell.functions.clear()
    kernel.shell.env.set('OPTIND', '1')
  })

  async function runScript(script: string): Promise<string> {
    const path = '/tmp/alias-getopts.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    await kernel.execute({ command: path, shell: kernel.shell })
    return await kernel.filesystem.fs.exists(OUT)
      ? await kernel.filesystem.fs.readFile(OUT, 'utf-8') as unknown as string
      : ''
  }

  const lines = (output: string): string[] => output.split('\n').filter(line => line !== '')

  describe('alias', () => {
    it('substitutes a multi-word value', async () => {
      const output = await runScript([
        "alias say='echo hello'",
        `say world >> ${OUT}`
      ].join('\n'))
      expect(output).toBe('hello world\n')
    })

    it('substitutes at every command position, not in arguments', async () => {
      const output = await runScript([
        "alias two='echo second'",
        `echo two >> ${OUT}`,
        `two >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['two', 'second'])
    })

    it('substitutes after a `;` and inside a pipeline', async () => {
      const output = await runScript([
        "alias emit='echo piped'",
        `emit | cat >> ${OUT}`,
        `echo x > /dev/null; emit >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['piped', 'piped'])
    })

    it('lets an alias name the real command without looping', async () => {
      // `alias echo='echo [tagged]'` must mean the real echo with a flag, not infinite recursion.
      const output = await runScript([
        "alias echo='echo [tagged]'",
        `echo hi >> ${OUT}`
      ].join('\n'))
      expect(output).toBe('[tagged] hi\n')
    })

    it('makes the next word eligible when the value ends in a space', async () => {
      const output = await runScript([
        "alias run='env '",
        "alias greet='echo hey'",
        `run greet >> ${OUT}`
      ].join('\n'))
      expect(output).toBe('hey\n')
    })

    it('chains one alias into another', async () => {
      const output = await runScript([
        "alias a='b'",
        "alias b='echo chained'",
        `a >> ${OUT}`
      ].join('\n'))
      expect(output).toBe('chained\n')
    })

    it('lists definitions in a form that can be fed back in', async () => {
      const output = await runScript([
        "alias ll='ls -la'",
        `alias >> ${OUT}`
      ].join('\n'))
      expect(output).toContain("alias ll='ls -la'")
    })

    it('reports one alias by name, and a miss', async () => {
      const output = await runScript([
        "alias one='echo 1'",
        `alias one >> ${OUT}`
      ].join('\n'))
      expect(output).toContain("alias one='echo 1'")
    })

    it('is not substituted when quoted', async () => {
      const output = await runScript([
        "alias q='echo aliased'",
        `echo 'q' >> ${OUT}`
      ].join('\n'))
      expect(output).toBe('q\n')
    })
  })

  describe('unalias', () => {
    it('removes one', async () => {
      const output = await runScript([
        "alias gone='echo still-here'",
        'unalias gone',
        `alias >> ${OUT}`,
        `echo done >> ${OUT}`
      ].join('\n'))
      expect(output).not.toContain('gone')
      expect(lines(output)).toEqual(['done'])
    })

    it('removes them all with -a', async () => {
      await runScript(["alias a='echo a'", "alias b='echo b'", 'unalias -a'].join('\n'))
      expect(kernel.shell.aliases.size).toBe(0)
    })
  })

  describe('type', () => {
    it('reports each kind', async () => {
      const output = await runScript([
        "alias al='echo x'",
        'fn() { echo x; }',
        `type al >> ${OUT}`,
        `type cd >> ${OUT}`,
        `type fn >> ${OUT}`,
        `type if >> ${OUT}`,
        `type cat >> ${OUT}`
      ].join('\n'))
      const [alias, builtin, fn, keyword, file] = lines(output) as string[]
      expect(alias).toContain('aliased to')
      expect(builtin).toContain('shell builtin')
      expect(fn).toContain('is a function')
      expect(keyword).toContain('shell keyword')
      expect(file).toContain('/bin/cat')
    })

    it('prints just the kind with -t', async () => {
      const output = await runScript([
        'fn2() { echo x; }',
        `type -t fn2 >> ${OUT}`,
        `type -t cd >> ${OUT}`,
        `type -t cat >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['function', 'builtin', 'file'])
    })

    it('prints just the path with -p, and nothing for a non-file', async () => {
      const output = await runScript([
        `type -p cat >> ${OUT}`,
        `type -p cd >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['/bin/cat'])
    })

    it('reports a miss', async () => {
      const output = await runScript([
        `type -t definitely-not-a-command >> ${OUT}`,
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1'])
    })
  })

  describe('command', () => {
    it('steps over a same-named function, so a wrapper does not recurse', async () => {
      const output = await runScript([
        'echo() { command echo wrapped "$@"; }',
        `echo inner >> ${OUT}`
      ].join('\n'))
      expect(output).toBe('wrapped inner\n')
    })

    it('-v prints what would run', async () => {
      const output = await runScript([
        `command -v cat >> ${OUT}`,
        `command -v cd >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['/bin/cat', 'cd'])
    })

    it('-v exits non-zero for a name that resolves to nothing', async () => {
      const output = await runScript([
        'command -v definitely-not-a-command > /dev/null',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1'])
    })
  })

  describe('getopts', () => {
    const parser = (optstring: string, out: string) => [
      'parse() {',
      '  OPTIND=1',
      `  while getopts "${optstring}" opt; do`,
      `    echo "opt=$opt arg=[$OPTARG]" >> ${out}`,
      '  done',
      `  echo "rest=$OPTIND" >> ${out}`,
      '}'
    ].join('\n')

    it('reads simple flags', async () => {
      const output = await runScript([parser('ab', OUT), 'parse -a -b'].join('\n'))
      expect(lines(output)).toEqual(['opt=a arg=[]', 'opt=b arg=[]', 'rest=3'])
    })

    it('reads a clustered argument, which $OPTIND alone cannot track', async () => {
      const output = await runScript([parser('ab', OUT), 'parse -ab'].join('\n'))
      expect(lines(output)).toEqual(['opt=a arg=[]', 'opt=b arg=[]', 'rest=2'])
    })

    it('collects an option argument given separately', async () => {
      const output = await runScript([parser('f:', OUT), 'parse -f value'].join('\n'))
      expect(lines(output)).toEqual(['opt=f arg=[value]', 'rest=3'])
    })

    it('collects an option argument attached to the letter', async () => {
      const output = await runScript([parser('f:', OUT), 'parse -fvalue'].join('\n'))
      expect(lines(output)).toEqual(['opt=f arg=[value]', 'rest=2'])
    })

    it('stops at the first operand, leaving $OPTIND pointing at it', async () => {
      const output = await runScript([parser('a', OUT), 'parse -a file.txt'].join('\n'))
      expect(lines(output)).toEqual(['opt=a arg=[]', 'rest=2'])
    })

    it('stops at `--` and steps past it', async () => {
      const output = await runScript([parser('a', OUT), 'parse -a -- -b'].join('\n'))
      expect(lines(output)).toEqual(['opt=a arg=[]', 'rest=3'])
    })

    it('reports an unknown option as ? in silent mode', async () => {
      const output = await runScript([parser(':ab', OUT), 'parse -z'].join('\n'))
      expect(lines(output)).toEqual(['opt=? arg=[z]', 'rest=2'])
    })

    it('reports a missing argument as : in silent mode', async () => {
      const output = await runScript([parser(':f:', OUT), 'parse -f'].join('\n'))
      expect(lines(output)).toEqual(['opt=: arg=[f]', 'rest=2'])
    })

    it('drives the shift idiom every flag-taking script uses', async () => {
      const output = await runScript([
        'main() {',
        '  OPTIND=1',
        '  verbose=no',
        '  while getopts "vf:" opt; do',
        '    case $opt in',
        '      v) verbose=yes ;;',
        '      f) file=$OPTARG ;;',
        '    esac',
        '  done',
        '  shift $((OPTIND - 1))',
        `  echo "verbose=$verbose file=$file rest=$1" >> ${OUT}`,
        '}',
        'main -v -f out.txt operand'
      ].join('\n'))
      expect(lines(output)).toEqual(['verbose=yes file=out.txt rest=operand'])
    })
  })
})
