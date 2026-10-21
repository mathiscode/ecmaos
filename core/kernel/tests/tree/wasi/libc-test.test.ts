import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * musl's libc-test, its functional and regression tests, built on WALI's musl into one program (`libc-test/build.sh`,
 * `libc-test/runner.c`) that runs each test as a child with a time limit. What fails today is listed with why in
 * `libc-test/expected-failures.txt`; a failure not on the list fails this test, and so does a test on it that passes.
 */
describe('libc-test on WALI', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  })

  it('fails only the tests expected to', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const here = `${process.cwd()}/tests/tree/wasi/libc-test`
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/libc-test.d', { recursive: true })
    await fs.writeFile('/tmp/libc-test', new Uint8Array(readFileSync(`${here}/libc-test.wasm`)), { mode: 0o755 })
    // a test that replaces part of libc is a program of its own
    const own = ['regression.flockfile-list']
    for (const name of own) await fs.writeFile(`/tmp/libc-test.d/${name}`, new Uint8Array(readFileSync(`${here}/${name}.wasm`)), { mode: 0o755 })
    await kernel.shell.execute(`cd /tmp/libc-test.d && /tmp/libc-test run /tmp/libc-test.d > /tmp/libc-test.out 2>&1; /tmp/libc-test run /tmp/libc-test.d ${own.join(' ')} >> /tmp/libc-test.out 2>&1`)
    const report = await fs.readFile('/tmp/libc-test.out', 'utf8')

    const results = new Map([...report.matchAll(/^(PASS|FAIL) (\S+?):?(?: |$)/gm)].map(([, result, name]) => [name, result]))
    const expected = new Set(readFileSync(`${here}/expected-failures.txt`, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(/\s+/)[0]))
    const failing = [...results].filter(([, result]) => result === 'FAIL').map(([name]) => name)
    // what each unexpected failure printed, so the assertion says why
    const details = (name: string) => report.slice(report.indexOf(`FAIL ${name}`)).split('\n').slice(0, 8).join('\n')

    expect(results.size).toBeGreaterThan(100)
    expect(failing.filter(name => !expected.has(name)).map(details)).toEqual([])
    expect([...expected].filter(name => results.get(name) === 'PASS').map(name => `${name} passes now: take it off expected-failures.txt`)).toEqual([])
    expect([...expected].filter(name => !results.has(name)).map(name => `${name} did not run`)).toEqual([])
  }, 300_000)
})
