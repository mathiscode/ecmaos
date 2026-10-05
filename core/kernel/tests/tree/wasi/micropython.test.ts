import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/micropython` is MicroPython's Unix port built to WebAssembly (`core/utils/wasm/micropython`). Its garbage
 * collector scans the C stack for pointers, which only finds everything because the build spills wasm locals to that
 * stack (`--spill-pointers`); the stress tests below are what keeps that true.
 */

/** Allocation-heavy work through C builtins (sorted with a key, join over a generator, map, zip, dict and set
 * comprehensions, closures, bytes) that prints one checksum. CPython prints the same number (1445180); on a heap this
 * small the collector runs constantly, and a value it fails to see comes out as a wrong sum, a TypeError or a crash. */
const STRESS = `
import gc

def mk(i):
    return {"id": i, "name": "n%d" % i, "tags": ["t%d" % (i % 7), "u%d" % (i % 3)], "pair": (i, i * 2), "blob": bytes([i % 256]) * 5}

def gen(n):
    for i in range(n):
        yield mk(i)

def closure(k):
    acc = []
    def add(x):
        acc.append("%s-%d" % (x, k))
        return acc
    return add

class Node:
    def __init__(self, v, nxt=None):
        self.v = v
        self.nxt = nxt
        self.label = "node-%d" % v

def chain(n):
    head = None
    for i in range(n):
        head = Node(i, head)
    return head

def walk(h):
    t = 0
    c = 0
    while h:
        t += h.v
        c += len(h.label)
        h = h.nxt
    return t, c

total = 0
for rnd in range(25):
    recs = list(gen(120))
    recs.sort(key=lambda r: (r["name"], r["pair"][1], r["tags"]))
    total += sum(len(r["name"]) + r["blob"][0] for r in recs)
    s = "|".join("%s:%s" % (r["id"], ",".join(r["tags"])) for r in recs)
    total += len(s) + s.count("t3")
    add = closure(rnd)
    for r in recs[:50]:
        add(r["name"])
    total += len(add("x")) + len(add("y")[0])
    h = chain(150)
    total += walk(h)[0] + walk(h)[1]
    ba = bytearray()
    for r in recs:
        ba += r["blob"]
    total += len(ba) + sum(ba)
    lines = ["%05d %s %s" % (r["id"], r["name"], r["tags"][0]) for r in recs]
    total += len(" ".join(lines).split(" "))
    fs = [f for f in (lambda x, y=rnd: [x, y, str(x) * 3] for x in range(80))]
    total += len(list(map(lambda f: f(3), fs)))
    try:
        {}["missing" + str(rnd)]
    except KeyError as e:
        total += len(str(e.args[0]))
    st = set(r["name"] for r in recs)
    total += len(st) + len(sorted(st)[0])
    gc.collect()
print(total)
`

describe('micropython', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
  })

  const waitFor = async (check: () => boolean, timeoutMs = 20000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  const screenText = () => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/mp.out 2> /tmp/mp.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/mp.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/mp.err', 'utf8') }
  }

  it('runs a command line, a script with its arguments, and a script from a pipe', async () => {
    expect(await run(`micropython -c 'print(sum(range(10)), "hi")'`)).toEqual({ code: 0, out: '45 hi\n', err: '' })
    await kernel.filesystem.fs.writeFile('/tmp/mp-args.py', 'import sys\nprint(sys.argv[1:], 2 ** 100, "é".encode())\n')
    expect(await run('micropython /tmp/mp-args.py a b')).toEqual({ code: 0, out: "['a', 'b'] 1267650600228229401496703205376 b'\\xc3\\xa9'\n", err: '' })
    expect(await run(`echo 'print(6 * 7)' | micropython`)).toEqual({ code: 0, out: '42\n', err: '' })
  }, 60000)

  it('prints a traceback on stderr and exits 1; sys.exit sets the status; a missing file exits 2', async () => {
    const bad = await run(`micropython -c 'raise ValueError("boom")'`)
    expect(bad.code).toBe(1)
    expect(bad.out).toBe('')
    expect(bad.err).toContain('ValueError: boom')
    expect((await run(`micropython -c 'import sys; sys.exit(3)'`)).code).toBe(3)
    const missing = await run('micropython /tmp/no-such-file.py')
    expect(missing.code).toBe(2)
    expect(missing.err).toContain("can't open file")
  }, 60000)

  it('reaches the filesystem, the shell and the clock', async () => {
    const script = [
      'import os, time',
      'os.mkdir("/tmp/mp-dir")',
      'f = open("/tmp/mp-dir/a.txt", "w"); f.write("x\\n" * 3); f.close()',
      'print(os.listdir("/tmp/mp-dir"), open("/tmp/mp-dir/a.txt").read().count("x"), os.stat("/tmp/mp-dir/a.txt")[6], os.getcwd())',
      'print(os.system("echo from-shell"))',
      't = time.time(); time.sleep(0.2); print(time.time() - t > 0.15)',
      'print(os.statvfs("/")[0] > 0)'
    ].join('\n')
    await kernel.filesystem.fs.writeFile('/tmp/mp-os.py', script)
    expect(await run('micropython /tmp/mp-os.py')).toEqual({ code: 0, out: "['a.txt'] 3 6 /root\nfrom-shell\n0\nTrue\nTrue\n", err: '' })
  }, 60000)

  it('has the standard library modules a script expects', async () => {
    const { out, code } = await run(`micropython -c 'import re, json, struct, hashlib, random, collections, io, errno, binascii, heapq, array; print(re.match("a(b+)", "abbb").group(1), json.dumps({"a": [1, 2]}), struct.pack("<I", 5), hashlib.sha256(b"a").digest()[:2])'`)
    expect(code).toBe(0)
    expect(out).toBe('bbb {"a": [1, 2]} b\'\\x05\\x00\\x00\\x00\' b\'\\xca\\x97\'\n')
  }, 60000)

  it('raises RuntimeError for runaway recursion instead of trapping', async () => {
    const { out, code } = await run(`micropython -c 'exec("def f(n): return f(n + 1)\\ntry: f(0)\\nexcept RuntimeError as e: print(e)")'`)
    expect(code).toBe(0)
    expect(out).toBe('maximum recursion depth exceeded\n')
  }, 60000)

  it('collects garbage correctly on small heaps: the same checksum as CPython', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/mp-stress.py', STRESS)
    for (const heap of ['256k', '512k', '2m']) {
      expect(await run(`micropython -X heapsize=${heap} /tmp/mp-stress.py`), `heap ${heap}`).toEqual({ code: 0, out: '1445180\n', err: '' })
    }
  }, 120000)

  it('reports an exhausted heap as MemoryError', async () => {
    const { code, err } = await run(`micropython -X heapsize=64k -c 'x = [str(i) * 50 for i in range(100000)]'`)
    expect(code).toBe(1)
    expect(err).toContain('MemoryError')
  }, 60000)

  it('runs the REPL on the terminal: evaluates, recalls history with the arrow keys, and exits on ^D', async () => {
    const done = kernel.shell.execute('micropython')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => screenText().includes('>>> '))
    expect(screenText()).toContain('MicroPython v')
    const type = async (keys: string) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, 400)) }
    await type('6 * 7\r')
    await waitFor(() => /^42$/m.test(screenText()))
    await type('def f(x):\r')
    await type('    return x + 1\r')
    await type('\r')
    await type('f(41)\r')
    await waitFor(() => /^42$/m.test(screenText()) && screenText().split('\n').filter(line => line === '42').length >= 2)
    await type('\x1b[A') // Up (the normal-mode sequence; MicroPython does not switch the keypad to application mode): the previous line
    await waitFor(() => screenText().split('\n').some(line => line === '>>> f(41)' && screenText().indexOf(line) !== screenText().lastIndexOf(line)))
    await type('\x03') // ^C abandons the recalled line and gives a fresh prompt
    await waitFor(() => screenText().trimEnd().endsWith('>>> f(41)\n>>>'))
    await type('\x04')
    expect(await done).toBe(0)
  }, 90000)
})
