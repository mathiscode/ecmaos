import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { tokenize } from '@ecmaos/coreutils/lib/shell-parser'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('process substitution: parsing', () => {
  it('is one word, with the command kept', () => {
    const tokens = tokenize('diff <(sort a) >(cat)')
    expect(tokens.map(t => t.kind)).toEqual(['word', 'word', 'word'])
    expect((tokens[1] as { parts: Array<{ procSub?: unknown }> }).parts[0]?.procSub).toEqual({ direction: '<', command: 'sort a' })
    expect((tokens[2] as { parts: Array<{ procSub?: unknown }> }).parts[0]?.procSub).toEqual({ direction: '>', command: 'cat' })
  })

  it('keeps nested parentheses and quotes inside the command', () => {
    const tokens = tokenize(`cat <(echo "a)" $(echo b))`)
    expect((tokens[1] as { parts: Array<{ procSub?: { command: string } }> }).parts[0]?.procSub?.command).toBe('echo "a)" $(echo b)')
  })

  it('still reads `< <(cmd)` as a redirection of a substitution', () => {
    expect(tokenize('read x < <(echo hi)').map(t => t.kind)).toEqual(['word', 'word', 'redirect', 'word'])
  })

  it('does not treat a redirection followed by a space as one', () => {
    expect(tokenize('cat < (a)').map(t => t.kind)).toEqual(['word', 'redirect', 'word'])
  })

  it('reports an unclosed one', () => {
    expect(() => tokenize('cat <(echo hi')).toThrow(/process substitution/)
  })
})

describe('process substitution: running', () => {
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

  const fs = () => kernel.filesystem.fs
  const out = async (line: string) => {
    await kernel.shell.execute(`${line} > /tmp/ps-out`)
    return await fs().readFile('/tmp/ps-out', 'utf-8')
  }

  it('<(cmd) is a readable path', async () => {
    expect(await out('cat <(echo hello)')).toBe('hello\n')
  })

  it('diff compares two commands', async () => {
    await fs().writeFile('/tmp/ps-a', 'one\ntwo\n')
    await fs().writeFile('/tmp/ps-b', 'one\nthree\n')
    const code = await kernel.shell.execute('diff <(cat /tmp/ps-a) <(cat /tmp/ps-b) > /tmp/ps-diff')
    expect(code).toBe(1)
    const diff = await fs().readFile('/tmp/ps-diff', 'utf-8')
    expect(diff).toContain('two')
    expect(diff).toContain('three')
  })

  it('a pipeline inside the substitution works', async () => {
    expect(await out('cat <(echo b; echo a | cat)')).toBe('b\na\n')
  })

  it('feeds a while loop: done < <(cmd)', async () => {
    await kernel.shell.execute('n=0; while read l; do n=$((n+1)); echo "$l" >> /tmp/ps-loop; done < <(printf "x\\ny\\n")')
    expect(await fs().readFile('/tmp/ps-loop', 'utf-8')).toBe('x\ny\n')
  })

  it('>(cmd) receives what the command wrote, once it has finished', async () => {
    await fs().rm('/tmp/ps-sink', { force: true })
    await kernel.shell.execute('echo captured | tee >(cat > /tmp/ps-sink) > /dev/null')
    expect(await fs().readFile('/tmp/ps-sink', 'utf-8')).toBe('captured\n')
  })

  it('removes its temporary files', async () => {
    await kernel.shell.execute('cat <(echo x) >(cat) > /dev/null')
    const left = (await fs().readdir('/tmp')).filter(name => name.startsWith('.procsub-'))
    expect(left).toEqual([])
  })

  it('a redirected block sends only its last pipeline stage to the file', async () => {
    // Regression: the block's `>` was applied to every stage, so `echo` wrote to the file and `cat`
    // waited forever on a pipe that never got a byte.
    await kernel.shell.execute('for i in 1 2; do echo n$i | cat; done > /tmp/ps-block')
    expect(await fs().readFile('/tmp/ps-block', 'utf-8')).toBe('n1\nn2\n')
  })

  it('an exit inside the substitution does not end the shell', async () => {
    await kernel.shell.execute('cat <(echo before; exit 3) > /tmp/ps-exit; echo after >> /tmp/ps-exit')
    expect(await fs().readFile('/tmp/ps-exit', 'utf-8')).toBe('before\nafter\n')
  })
})
