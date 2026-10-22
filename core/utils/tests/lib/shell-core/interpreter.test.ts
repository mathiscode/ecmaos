import { describe, expect, it } from 'vitest'

import { FakeHost } from './fake-host.ts'

const run = async (text: string, setup?: (host: FakeHost) => void) => {
  const host = new FakeHost()
  setup?.(host)
  const status = await host.run(text)
  return { host, status, out: host.out.join('|') }
}

describe('Interpreter: lists', () => {
  it('runs ; lists in order and reports the last status', async () => {
    const { out, status } = await run('echo a; echo b; false')
    expect(out).toBe('a|b')
    expect(status).toBe(1)
  })

  it('&& and || decide each next stage, and a skipped stage leaves the status for the next operator', async () => {
    expect((await run('false && echo no || echo yes')).out).toBe('yes')
    expect((await run('true || echo no; echo end')).out).toBe('end')
    expect((await run('true && false || echo rescued')).out).toBe('rescued')
  })

  it('records PIPESTATUS and honours pipefail', async () => {
    const plain = await run('true | fail 3 | true')
    expect(plain.status).toBe(0)
    expect(plain.host.state.lookupArray('PIPESTATUS')?.get(1)).toBe('3')
    const strict = await run('set -o pipefail; true | fail 3 | true')
    expect(strict.status).toBe(3)
  })

  it('does not let a failed background start affect the line', async () => {
    const { out } = await run('echo a &')
    expect(out).toBe('bg:echo a')
  })
})

describe('Interpreter: set -e', () => {
  it('stops on an untested failure', async () => {
    const { out, status } = await run('set -e; echo a; false; echo b')
    expect(out).toBe('a')
    expect(status).toBe(1)
  })

  it('does not stop on a tested failure', async () => {
    const { out } = await run('set -e; false && echo no; if false; then echo no; fi; ! false; echo kept')
    expect(out).toBe('kept')
  })

  it('does stop on the failing right-hand side of &&', async () => {
    const { out } = await run('set -e; true && false; echo b')
    expect(out).toBe('')
  })

  it('stops inside a function and a loop, ending the whole script', async () => {
    const { out } = await run('f() { false; echo in; }; set -e; f; echo after')
    expect(out).toBe('')
    expect((await run('set -e; for i in 1 2; do echo $i; false; done; echo after')).out).toBe('$i')
  })

  it('stops a subshell at a failure, and then the shell too, as the subshell failed', async () => {
    const { out } = await run('set -e; (false; echo no); echo after')
    expect(out).toBe('')
  })

  it('ignores set -e inside a subshell that is being tested, as bash does', async () => {
    const { out } = await run('set -e; (false; echo no) || echo handled; echo after')
    expect(out).toBe('no|after')
  })
})

describe('Interpreter: ERR trap', () => {
  it('fires on an untested failure with the status preserved', async () => {
    const { out, status } = await run("trap 'echo err' ERR; false; echo done")
    expect(out).toBe('err|done')
    expect(status).toBe(0)
  })

  it('does not fire for a tested failure or recurse', async () => {
    const { out } = await run("trap 'echo err; false' ERR; false || true; if false; then :; fi; echo ok")
    expect(out).toBe('ok')
    const loop = await run("trap 'echo err; false' ERR; false; echo ok")
    expect(loop.out).toBe('err|ok')
  })
})

describe('Interpreter: compound statements', () => {
  it('if / elif / else', async () => {
    expect((await run('if false; then echo a; elif true; then echo b; else echo c; fi')).out).toBe('b')
    expect((await run('if false; then echo a; else echo c; fi')).out).toBe('c')
  })

  it('while and until', async () => {
    const counted = await run('x= x= ; while status; do break; done; until true; do echo no; done; echo end')
    expect(counted.out).toBe('0|end')
  })

  it('for, with break and continue', async () => {
    expect((await run('for i in a b c; do echo $i; done')).out).toBe('$i|$i|$i')
    const { host } = await run('for i in a b c; do x= ; done')
    expect(host.state.lookup('i')).toBe('c')
    expect((await run('for i in a b c; do echo x; break; done; echo end')).out).toBe('x|end')
    expect((await run('for i in a b; do continue; echo no; done; echo end')).out).toBe('end')
  })

  it('break 2 leaves two loops and not three', async () => {
    const { out } = await run('for i in 1 2; do for j in 1 2; do echo in; break 2; done; echo no; done; echo end')
    expect(out).toBe('in|end')
  })

  it('case', async () => {
    expect((await run('case a in b) echo no;; a) echo yes;; esac')).out).toBe('yes')
    expect((await run('case z in b) echo no;; *) echo any;; esac')).out).toBe('any')
  })

  it('a stray break outside a loop is not swallowed by an enclosing function', async () => {
    const { out, host } = await run('f() { break; echo after; }; for i in 1 2; do f; echo body; done')
    expect(host.errors.join()).toContain('only meaningful')
    expect(out).toBe('body|body')
  })

  it('{ } shares state and ( ) does not', async () => {
    const group = await run('{ x= a b; }; echo ok')
    expect(group.out).toBe('ok')
    const sub = await run('(x= v 1); echo done')
    expect(sub.host.state.lookup('v')).toBeUndefined()
  })
})

describe('Interpreter: functions', () => {
  it('passes arguments and restores them', async () => {
    const { out } = await run('f() { args; }; f a b; args')
    expect(out).toBe('[a,b]|[]')
  })

  it('return gives the call its status and stops the body', async () => {
    const { out, status } = await run('f() { return 4; echo no; }; f; status')
    expect(out).toBe('4')
    expect(status).toBe(0)
  })

  it('bounds recursion', async () => {
    const { host, status } = await run('f() { f; }; f')
    expect(host.errors.join()).toContain('maximum function nesting')
    expect(status).toBeDefined()
  })

  it('a local frame is popped even when the body throws', async () => {
    const { host } = await run('f() { exit 3; }; f')
    expect(host.interpreter.catchers).toEqual({ exit: 0, return: 0, loop: 0 })
  })
})

describe('Interpreter: syntax errors in compound commands', () => {
  it('finds one before running any of the compound, its branch taken or not, after the lines before it ran', async () => {
    const host = new FakeHost()
    await expect(host.run('echo before\nif false; then echo ); fi\necho after')).rejects.toThrow("unexpected token `)'")
    expect(host.out).toEqual(['before'])
    await expect(new FakeHost().run('while false; do echo $(; done')).rejects.toThrow()
    await expect(new FakeHost().run('f() { echo x (; }')).rejects.toThrow()
  })

  it('leaves an array assignment and (( )) in a compound alone', async () => {
    // (each host runs an array assignment itself, before parsing; this one has none, so the branch is not taken)
    const { out } = await run('if false; then a=( 1 2 ); fi; if true; then (( x = 1 )); echo ok; fi')
    expect(out).toBe('ok')
  })
})

describe('Interpreter: subshells and sourcing', () => {
  it('exit in a subshell ends only the subshell', async () => {
    const { out, status } = await run('(exit 3); status; echo after')
    expect(out).toBe('3|after')
    expect(status).toBe(0)
  })

  it('return in sourced text ends it, exit does not stop at it', async () => {
    const host = new FakeHost()
    expect(await host.interpreter.runSourced('echo a; return 5; echo b', ['p'])).toBe(5)
    expect(host.out).toEqual(['a'])
    await expect(host.interpreter.runSourced('exit 9')).rejects.toThrow('exit')
  })

  it('runs positional parameters for sourced text and puts them back', async () => {
    const host = new FakeHost()
    await host.interpreter.runSourced('args', ['one', 'two'])
    expect(host.out).toEqual(['[one,two]'])
    expect(host.params).toEqual([])
  })
})

describe('Interpreter: interrupt checkpoint', () => {
  it('stops a list and a loop when the host reports an interrupt', async () => {
    const { out } = await run('echo a; echo b; echo c', host => {
      host.onCommand = words => { if (words[1] === 'a') host.interrupted = true }
    })
    expect(out).toBe('a')
    const loop = await run('for i in 1 2 3; do echo x; done; echo after', host => {
      host.onCommand = () => { host.interrupted = true }
    })
    expect(loop.out).toBe('x')
  })

  it('sets $LINENO from the statement being run', async () => {
    const host = new FakeHost()
    await host.run('echo a\n\necho b')
    expect(host.state.lineNumber).toBe(3)
  })
})
