import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

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

/** Four threads allocating at once, and one holding strings only in its locals while it sleeps. A collection on any of
 * them stops the others with a real-time signal (`pthread_kill`), each scanning its own stack from its handler; the
 * computing ones take it at a loop's signal check, the sleeping one in its sleep. CPython prints the same list. */
const THREADS = `
import _thread, time

lock = _thread.allocate_lock()
results = {}

def work(k):
    total = 0
    for rnd in range(30):
        recs = [{"id": i, "s": "v%d-%d" % (k, i), "l": [i, str(i) * 3]} for i in range(100)]
        recs.sort(key=lambda r: (r["s"], r["l"][1]))
        total += sum(len(r["s"]) + len(r["l"][1]) for r in recs)
        s = ",".join(r["s"] for r in recs if r["id"] % 3)
        total += len(s) + s.count(str(k)) * (k + 1)
    with lock:
        results[k] = total

def sleeper():
    keep = ["held-%d" % i for i in range(200)]
    time.sleep(1)
    with lock:
        results[9] = sum(len(x) for x in keep)

_thread.start_new_thread(sleeper, ())
for k in range(4):
    _thread.start_new_thread(work, (k,))
while True:
    with lock:
        if len(results) == 5:
            break
    time.sleep(0.01)
print(sorted(results.items()))
`

describe('micropython', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
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

  it('python and python3 are links to micropython', async () => {
    expect(await kernel.filesystem.fs.readlink('/bin/python')).toBe('/bin/micropython')
    expect(await run(`python -c 'print("via link")'`)).toEqual({ code: 0, out: 'via link\n', err: '' })
    expect(await kernel.filesystem.fs.readlink('/bin/python3')).toBe('/bin/micropython')
    expect(await run(`python3 -c 'print("via python3")'`)).toEqual({ code: 0, out: 'via python3\n', err: '' })
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

  it('has the frozen micropython-lib modules, and asyncio', async () => {
    const script = [
      'import os, os.path, bisect, collections, fnmatch, functools, heapq, itertools, logging, operator, pathlib, random, stat, string, tempfile, time, traceback, types, warnings, asyncio',
      'print(os.path.join("/a", "b.txt"), os.path.basename("/a/b.txt"), os.path.split("/a/b.txt"), bool(os.path.isdir("/tmp")), os.path.exists("/nope"))',
      'print(os.path.isfile("/bin/micropython"), collections.defaultdict(list)["k"], collections.namedtuple("P", "x y")(1, 2).y)',
      'print(bisect.bisect([1, 3, 5], 4), fnmatch.fnmatch("a.py", "*.py"), functools.reduce(operator.add, range(5)), list(itertools.islice(itertools.count(3), 3)), heapq.nsmallest(2, [5, 1, 4]))',
      'print(pathlib.Path("/tmp") / "x" / "y.txt", string.ascii_lowercase[:3], types.FunctionType.__name__, stat.S_ISDIR(os.stat("/tmp")[0]))',
      'd = tempfile.mkdtemp(); print(bool(os.path.isdir(d)))',
      'async def work(n):\n    await asyncio.sleep(0.01)\n    return n * 2',
      'async def main():\n    return await asyncio.gather(work(1), work(2))',
      'print(asyncio.run(main()))'
    ].join('\n')
    await kernel.filesystem.fs.writeFile('/tmp/mp-lib.py', script)
    expect(await run('micropython /tmp/mp-lib.py')).toEqual({
      code: 0,
      out: "/a/b.txt b.txt ('/a', 'b.txt') True False\nTrue [] 2\n2 True 10 [3, 4, 5] [1, 4]\n/tmp/x/y.txt abc function True\nTrue\n[2, 4]\n",
      err: ''
    })
  }, 60000)

  it('has the modules derived from CPython: argparse, datetime, shutil, contextlib, copy and unittest', async () => {
    const script = [
      'import argparse, datetime, shutil, contextlib, copy, unittest, os',
      'p = argparse.ArgumentParser(); p.add_argument("--n", type=int, default=1); p.add_argument("name"); a = p.parse_args(["--n", "3", "x"]); print(a.n, a.name)',
      'print(datetime.date(2024, 2, 29) + datetime.timedelta(days=1), datetime.datetime(2024, 1, 2, 3, 4, 5).isoformat())',
      'print(copy.deepcopy({"a": [1, 2]}))',
      'open("/tmp/mp-sh-a", "w").write("data"); shutil.copyfileobj(open("/tmp/mp-sh-a"), open("/tmp/mp-sh-b", "w")); print(open("/tmp/mp-sh-b").read())',
      'with contextlib.suppress(KeyError): {}["x"]',
      'class T(unittest.TestCase):\n    def test_ok(self): self.assertEqual(1 + 1, 2)',
      'unittest.main()'
    ].join('\n')
    await kernel.filesystem.fs.writeFile('/tmp/mp-psf.py', script)
    const result = await run('micropython /tmp/mp-psf.py')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain("3 x\n2024-03-01 2024-01-02T03:04:05\n")
    expect(result.out).toContain("{'a': [1, 2]}\ndata\n")
    expect(result.out + result.err).toContain('OK')
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

  it('runs threads, collecting garbage while they compute and sleep: the same results as CPython', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/mp-threads.py', THREADS)
    for (const heap of ['256k', '2m']) {
      expect(await run(`micropython -X heapsize=${heap} /tmp/mp-threads.py`), `heap ${heap}`).toEqual({
        code: 0, out: '[(0, 45630), (1, 48270), (2, 50670), (3, 52830), (9, 1490)]\n', err: ''
      })
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
