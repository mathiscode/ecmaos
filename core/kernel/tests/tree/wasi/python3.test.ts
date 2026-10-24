import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/python3` is CPython built to WebAssembly (`core/utils/wasm/cpython/build.sh`), with its standard library in
 * /usr/lib/python3.14. It forks for os.fork, subprocess and multiprocessing, so it is rewritten with Asyncify.
 */
describe('python3', () => {
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
    // the program and its library are installed in the background; wait until it starts
    for (let tries = 0; tries < 100 && await kernel.shell.execute('python3 -c "import json" > /dev/null 2>&1') !== 0; tries++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 300000)

  const run = async (script: string) => {
    await kernel.filesystem.fs.writeFile('/tmp/py.py', script)
    const code = await kernel.shell.execute('python3 /tmp/py.py > /tmp/py.out 2> /tmp/py.err')
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/py.out', 'utf8'),
      // joining a thread leaves a blank line on stderr (not yet explained: the same calls from C leave none)
      err: (await kernel.filesystem.fs.readFile('/tmp/py.err', 'utf8')).trim()
    }
  }

  it('runs a script and finds its standard library', async () => {
    expect(await run('import sys, os, json\nprint(sys.version_info[:2], sys.prefix, json.dumps({"a": [1, 2]}))\n'))
      .toEqual({ code: 0, out: "(3, 14) /usr {\"a\": [1, 2]}\n", err: '' })
  }, 60000)

  it('has the batteries: asyncio, hashlib, decimal, datetime, dataclasses, re, os.system and os.popen', async () => {
    expect(await run(`import asyncio, hashlib, decimal, datetime, dataclasses, os, sys
async def main():
    await asyncio.sleep(0.01)
    return await asyncio.gather(asyncio.sleep(0, "a"), asyncio.sleep(0, "b"))
@dataclasses.dataclass
class P:
    x: int = 1
print(asyncio.run(main()), hashlib.sha256(b"abc").hexdigest()[:16], decimal.Decimal("1.1") + decimal.Decimal("2.2"), flush=True)
print(datetime.date(2026, 10, 24).isoformat(), P(), os.system("echo sys"), os.popen("echo pop").read().strip(), sys.platform)
`)).toEqual({ code: 0, out: "['a', 'b'] ba7816bf8f01cfea 3.3\nsys\n2026-10-24 P(x=1) 0 pop linux\n", err: '' })
  }, 60000)

  it('forks with os.fork, and waits for the child and its status', async () => {
    expect(await run(`import os
r, w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(r)
    os.write(w, b"from child")
    os._exit(7)
os.close(w)
print(os.read(r, 100).decode())
_, status = os.waitpid(pid, 0)
print(os.WEXITSTATUS(status))
`)).toEqual({ code: 0, out: 'from child\n7\n', err: '' })
  }, 60000)

  it('runs subprocess: run, check_output, a pipeline through a shell, Popen with a pipe', async () => {
    expect(await run(`import subprocess
print(subprocess.run(["echo", "hi"], capture_output=True, text=True).stdout, end="")
print(subprocess.check_output("echo a b | tr a-z A-Z", shell=True, text=True), end="")
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
print(p.communicate("via cat\\n")[0], end="")
print(subprocess.run(["sh", "-c", "exit 3"]).returncode)
`)).toEqual({ code: 0, out: 'hi\nA B\nvia cat\n3\n', err: '' })
  }, 60000)

  it('runs a process pool and a Process of multiprocessing, which fork', async () => {
    expect(await run(`import multiprocessing as mp, os
def sq(x): return x * x
if __name__ == "__main__":
    ctx = mp.get_context("fork")
    with ctx.Pool(2) as pool:
        print(pool.map(sq, range(20)))
    q = ctx.Queue()
    p = ctx.Process(target=lambda: q.put(os.getpid() != 0))
    p.start()
    print(q.get(), p.join(), p.exitcode)
`)).toEqual({ code: 0, out: '[0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225, 256, 289, 324, 361]\nTrue None 0\n', err: '' })
  }, 90000)

  // a semaphore shared by processes cannot be a word in shared memory (patch-multiprocessing.py); with one, two readers
  // of a queue both take its lock and read each other's messages
  it('shares a lock between processes that contend for it', async () => {
    expect(await run(`import multiprocessing as mp
def reader(q, out):
    out.put(sorted(q.get() for _ in range(5)))
ctx = mp.get_context("fork")
q, out = ctx.SimpleQueue(), ctx.SimpleQueue()
workers = [ctx.Process(target=reader, args=(q, out)) for _ in range(2)]
for w in workers: w.start()
for i in range(10): q.put(i)
print(sorted(out.get() + out.get()))
for w in workers: w.join()
`)).toEqual({ code: 0, out: '[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]\n', err: '' })
  }, 90000)

  it('has threads, signals, sockets, a selector and a regular expression', async () => {
    expect(await run(`import threading, signal, socket, selectors, re, os, time
out = []
t = threading.Thread(target=lambda: out.append("t")); t.start(); t.join()
got = []
signal.signal(signal.SIGUSR1, lambda *a: got.append(1))
os.kill(os.getpid(), signal.SIGUSR1)
a, b = socket.socketpair()
sel = selectors.DefaultSelector(); sel.register(a, selectors.EVENT_READ)
b.send(b"x")
print(out, got, len(sel.select(1)), re.sub(r"(\\d+)", r"<\\1>", "a1b22"), a.recv(1))
`)).toEqual({ code: 0, out: "['t'] [1] 1 a<1>b<22> b'x'\n", err: '' })
  }, 60000)
})
