import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * Programs from real toolchains, as a user would bring them: Rust `wasm32-wasip1`, Go `GOOS=wasip1`, plain C on emcc's
 * standalone libc, an emcc module with the pre-rename syscall names, and a Preview 2 component made from rustc output.
 * They pin which runtime each reaches and what it does, so the WASI cleanup (.docs/WASI_CLEANUP.md) can change the
 * routing without changing the results. Fixtures: tests/tree/wasi/fixtures/README.md.
 */
const fixtures = `${process.cwd()}/tests/tree/wasi/fixtures`

async function compile(wat: string): Promise<Uint8Array> {
  const wabt = await (await import('wabt')).default()
  const parsed = wabt.parseWat('fixture.wat', wat)
  const { buffer } = parsed.toBinary({})
  parsed.destroy()
  return buffer
}

function hasGo(): boolean {
  const { spawnSync } = process.getBuiltinModule('node:child_process')
  return spawnSync('go', ['version']).status === 0
}

function buildGo(): Uint8Array {
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  const { mkdtempSync, readFileSync } = process.getBuiltinModule('node:fs')
  const { tmpdir } = process.getBuiltinModule('node:os')
  const dir = mkdtempSync(`${tmpdir()}/go-wasip1-`)
  execFileSync('go', ['build', '-ldflags=-s -w', '-o', `${dir}/go.wasm`, `${fixtures}/go-wasip1.go`], { env: { ...process.env, GOOS: 'wasip1', GOARCH: 'wasm', GOCACHE: `${tmpdir()}/go-build-cache` } })
  return new Uint8Array(readFileSync(`${dir}/go.wasm`))
}

describe('wasm programs from real toolchains', () => {
  let kernel: Kernel

  const install = async (name: string, bytes: Uint8Array) => {
    await kernel.filesystem.fs.writeFile(`/tmp/${name}`, bytes, { mode: 0o755 })
    return `/tmp/${name}`
  }
  const fixture = (name: string) => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    return new Uint8Array(readFileSync(`${fixtures}/${name}`))
  }
  const run = async (line: string, stdin = '/dev/null') => {
    const code = await kernel.shell.execute(`${line} < ${stdin} > /tmp/tc.out 2> /tmp/tc.err`)
    return {
      code,
      stdout: await kernel.filesystem.fs.readFile('/tmp/tc.out', 'utf-8'),
      stderr: await kernel.filesystem.fs.readFile('/tmp/tc.err', 'utf-8')
    }
  }

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  describe('Rust wasm32-wasip1', () => {
    it('is routed to the worker', async () => {
      expect(await kernel.wasm.detectWasiVersion(fixture('rust-wasip1.wasm'))).toBe('preview1')
      expect(await kernel.wasm.canRunInWorker(fixture('rust-wasip1.wasm'))).toBe(true)
    })

    // Run from /tmp with a relative base: wasi-libc resolves it against the "." preopen.
    it('runs: arguments, files, directories, clock, stdin and its exit code', async () => {
      const program = await install('rust-wasip1.wasm', fixture('rust-wasip1.wasm'))
      await kernel.filesystem.fs.writeFile('/tmp/tc.in', 'typed\n')
      const { code, stdout, stderr } = await run(`cd /tmp && ${program} stdin 6 .`, '/tmp/tc.in')
      expect(stderr).toBe('rust-wasip1: stderr\n')
      expect(code).toBe(6)
      expect(stdout).toContain('args=stdin,6,.\n')
      expect(stdout).toContain('file=made by rust\n')
      expect(stdout).toContain('size=13\n')
      expect(stdout).toContain('dir=a.txt,b.txt,sub\n')
      expect(stdout).toContain('clock=true\n')
      expect(stdout).toContain('stdin=typed\n')
      expect(await kernel.filesystem.fs.readFile('/tmp/rust-wasip1.txt', 'utf-8')).toBe('made by rust\n')
    })

    // KNOWN BUG, found by this fixture: the host preopens "/" (fd 3) then "." (fd 4), and for an absolute path wasi-libc's
    // longest-prefix match ties between them and takes ".", stripping the leading slash, so "/tmp/x" is opened as
    // "<cwd>/tmp/x". Fixed in Phase 1 (WASI_CLEANUP.md); then this becomes a plain `it`.
    it('runs with absolute paths', async () => {
      const program = await install('rust-wasip1.wasm', fixture('rust-wasip1.wasm'))
      const { code, stderr } = await run(`${program} - 0 /tmp`)
      expect({ code, stderr }).toEqual({ code: 0, stderr: 'rust-wasip1: stderr\n' })
    })
  })

  describe('Go GOOS=wasip1', () => {
    it.skipIf(!hasGo())('runs the same checks (built on demand: the binary is 2.7 MB)', async () => {
      const bytes = buildGo()
      expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)
      const program = await install('go-wasip1.wasm', bytes)
      await kernel.filesystem.fs.writeFile('/tmp/tc.in', 'typed\n')
      const { code, stdout, stderr } = await run(`cd /tmp && ${program} stdin 6`, '/tmp/tc.in')
      expect({ code, stderr }).toEqual({ code: 6, stderr: 'go-wasip1: stderr\n' })
      expect(stdout).toContain('file=made by go\n')
      expect(stdout).toContain('dir=a.txt,b.txt,sub\n')
      expect(stdout).toContain('stdin=typed\n')
    }, 60_000)
  })

  describe('C on emcc standalone (imports only wasi_snapshot_preview1)', () => {
    it('is routed to the worker and runs', async () => {
      expect(await kernel.wasm.canRunInWorker(fixture('c-wasip1.wasm'))).toBe(true)
      const program = await install('c-wasip1.wasm', fixture('c-wasip1.wasm'))
      const { code, stdout, stderr } = await run(`${program} 9 extra`)
      expect(code).toBe(9)
      expect(stdout).toContain('argc=3\n')
      expect(stdout).toContain('arg=9\narg=extra\n')
      expect(stdout).toContain('clock=1\n')
      expect(stderr).toBe('c-wasip1: stderr\n')
    })
  })

  // Imports `env` names the host does not implement; they are stubbed, so it still links and runs in the worker.
  describe('emcc module with the pre-rename syscall names', () => {
    it('is routed to the worker and runs', async () => {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      const bytes = await compile(readFileSync(`${fixtures}/wasip1-old-emcc.wat`, 'utf-8'))
      expect((await kernel.wasm.inspectForWorker(bytes)).inWorker).toBe(true)
      const program = await install('old-emcc.wasm', bytes)
      const { code, stdout } = await run(program)
      expect({ code, stdout }).toEqual({ code: 4, stdout: 'old emcc\n' })
    })
  })

  // A component made from rustc output with jco's preview1 adapter: it reaches the filesystem through wasi:filesystem,
  // whose preopens follow the same rule as preview1's, and runs as a worker process
  describe('Preview 2 component built from rustc output', () => {
    it('is a component and runs in the worker', async () => {
      const bytes = fixture('rust-p2.wasm')
      expect(await kernel.wasm.detectWasiVersion(bytes)).toBe('preview2')
      expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)
    })

    it('runs: arguments, files, directories, clock, stdin and its exit code', async () => {
      const program = await install('rust-p2.wasm', fixture('rust-p2.wasm'))
      await kernel.filesystem.fs.writeFile('/tmp/tc.in', 'typed\n')
      const { code, stdout, stderr } = await run(`cd /tmp && ${program} stdin 6 .`, '/tmp/tc.in')
      expect(stderr).toBe('rust-wasip1: stderr\n')
      expect(code).toBe(1)
      expect(stdout).toContain('args=stdin,6,.\n')
      expect(stdout).toContain('file=made by rust\n')
      expect(stdout).toContain('dir=a.txt,b.txt,sub\n')
      expect(stdout).toContain('clock=true\n')
      expect(stdout).toContain('stdin=typed\n')
    }, 30_000)

    it('opens absolute paths', async () => {
      const program = await install('rust-p2.wasm', fixture('rust-p2.wasm'))
      const { code, stderr } = await run(`${program} - 0 /tmp`)
      expect({ code, stderr }).toEqual({ code: 0, stderr: 'rust-wasip1: stderr\n' })
      expect(await kernel.filesystem.fs.readFile('/tmp/rust-wasip1.txt', 'utf-8')).toBe('made by rust\n')
    }, 30_000)
  })
})
