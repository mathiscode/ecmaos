import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { kernelBuiltinHost } from '#lib/shell-builtins.ts'
import { programmableCompletion, splitLine } from '@ecmaos/coreutils/lib/shell-core/programmable-completion'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Tab completion driven by `complete`: static specs, a `-F` function reading `COMP_WORDS` and filling
 * `COMPREPLY`, a `-C` command, and the options that decide what happens when nothing matches.
 */
describe('programmable completion', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  }, 60000)

  const shell = () => kernel.shell
  const define = (script: string) => shell().executeScriptText(script, '/tmp/complete-setup.sh')
  const complete = (line: string) => programmableCompletion(kernelBuiltinHost(shell()), line)

  beforeEach(async () => {
    await define('complete -r')
    await kernel.filesystem.fs.mkdir('/tmp/pc/sub', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/pc/file.txt', 'x')
    await shell().execute('cd /tmp/pc')
  })

  it('splits a line the way the shell does, quotes kept, a trailing space starting a new word', () => {
    expect(splitLine('git "a b" c\\ d ')).toEqual(['git', '"a b"', 'c\\ d', ''])
    expect(splitLine('')).toEqual([''])
  })

  it('is left alone when nothing is registered, so the ordinary completion answers', async () => {
    expect(await complete('git ch')).toBeUndefined()
    await define('complete -W "go" other')
    expect(await complete('git ch')).toBeUndefined()
  })

  it('completes from a word list, whole line back, sorted', async () => {
    await define('complete -W "checkout cherry-pick commit" git')
    expect(await complete('git ch')).toEqual(['git checkout', 'git cherry-pick'])
    expect(await complete('git ')).toEqual(['git checkout', 'git cherry-pick', 'git commit'])
    expect(await complete('git zz')).toEqual([])
  })

  it('runs a -F function with COMP_WORDS, COMP_CWORD, COMP_LINE and the three arguments', async () => {
    await define(`_t() { COMPREPLY=("$1" "$2" "$3" "cw=$COMP_CWORD" "n=\${#COMP_WORDS[@]}" "line=$COMP_LINE"); }; complete -F _t tool`)
    expect(await complete('tool one tw')).toEqual([
      'tool one cw=2', 'tool one line=tool one tw', 'tool one n=3', 'tool one one', 'tool one tool', 'tool one tw',
    ])
  })

  it('cleans up the COMP_ variables and leaves $? and the function status alone', async () => {
    await define('_u() { COMPREPLY=(a); false; }; complete -F _u thing; true')
    expect(await complete('thing ')).toEqual(['thing a'])
    expect(shell().env.get('?')).toBe('0')
    expect(shell().env.get('COMP_CWORD')).toBeUndefined()
    expect(shell().state.lookupArray('COMPREPLY')).toBeUndefined()
  })

  it('runs a -C command and takes its output lines', async () => {
    await define('_lister() { printf "%s\\n" alpha beta; }; complete -C _lister cmdtool')
    expect(await complete('cmdtool a')).toEqual(['cmdtool alpha', 'cmdtool beta'])
  })

  it('applies -X, -P and -S to what it found', async () => {
    await define('complete -W "a.c b.o c.c" -X "*.o" -P "<" -S ">" cc')
    expect(await complete('cc ')).toEqual(['cc <a.c>', 'cc <c.c>'])
  })

  it('falls back to filenames with -o default, and completes directories with -o dirnames', async () => {
    await define('complete -W "zzz" -o default plain; complete -W "zzz" -o dirnames dirs')
    expect(await complete('plain fi')).toEqual(['plain file.txt'])
    expect(await complete('dirs su')).toEqual(['dirs sub'])
  })

  it('with -o filenames escapes spaces and marks directories', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/pc/two words', 'x')
    await define('complete -f -o filenames viewer')
    expect(await complete('viewer s')).toEqual(['viewer sub/'])
    expect(await complete('viewer two')).toEqual(['viewer two\\ words'])
  })

  it('uses the -D fallback for a command with no spec, and -E for an empty line', async () => {
    await define('complete -W "anything" -D; complete -W "blank" -E')
    expect(await complete('unknown ')).toEqual(['unknown anything'])
    expect(await complete('')).toEqual(['blank'])
  })

  it('lets a function change the options of the completion being run with compopt', async () => {
    await define('_c() { compopt -o nospace; COMPREPLY=(x); }; complete -F _c cc2')
    await complete('cc2 ')
    // compopt reached the spec the function ran under
    expect(shell().state.completions.commands.get('cc2')?.options).toContain('nospace')
  })

  it('looks the spec up again when the function returns 124', async () => {
    await define('_loader() { complete -W "loaded" late; return 124; }; complete -F _loader late')
    expect(await complete('late l')).toEqual(['late loaded'])
  })
})
