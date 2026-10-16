import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './kernel.fixtures'
import { buffers, cases } from './gnu-tools.corpus.mjs'
import golden from './gnu-tools.golden.json'
import { known } from './gnu-tools.known'

/**
 * The text tools and archivers against what the real ones printed for the same commands (gnu-tools.golden.json, made by
 * generate-gnu-tools.mjs): standard output and the exit status. Each command runs in a fresh directory holding the corpus
 * files. Differences that are accepted are pinned in gnu-tools.known.ts with their reason. The corpus is cut into shards so
 * the files run in parallel. If /tmp/gnu-tools-report names a file, every result is appended to that file as one JSON line and
 * nothing is asserted, which is how the known differences are listed (the test environment does not pass environment variables on).
 */
const latin1 = (bytes: Uint8Array) => Array.from(bytes, byte => String.fromCharCode(byte)).join('')

// the test environment stubs the ES import of node:fs, so the real module comes from require
const nodeFs = typeof require === 'function' ? require('node:fs') : undefined
const reportFile = nodeFs?.existsSync('/tmp/gnu-tools-report') ? nodeFs.readFileSync('/tmp/gnu-tools-report', 'utf8').trim() : undefined

// in report mode, /tmp/gnu-tools-filter holds a regular expression: only the commands that match it run
const reportFilter = nodeFs?.existsSync('/tmp/gnu-tools-filter') ? new RegExp(nodeFs.readFileSync('/tmp/gnu-tools-filter', 'utf8').trim()) : undefined

const corpusFilter = __CORPUS_FILTER__ ? new RegExp(__CORPUS_FILTER__) : undefined

type Golden = { cmd: string, out: string, code: number, err: string }

export function defineGnuTools(shard: number, shards: number) {
  const noMatch = corpusFilter && !(golden as Golden[]).some((expected, index) => index % shards === shard && corpusFilter.test(expected.cmd))
  describe(`text tools match the real ones (${shard + 1} of ${shards})`, () => {
    if (noMatch) { it.skip('no case matches CORPUS_FILTER', () => {}); return }
    let kernel: Kernel

    beforeAll(async () => {
      kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
      await kernel.boot()
      await kernel.filesystem.fs.mkdir('/tmp/gnut', { recursive: true })
    }, 60000)

    ;(golden as Golden[]).forEach((expected, index) => {
      if (index % shards !== shard) return
      if (reportFile && reportFilter && !reportFilter.test(expected.cmd)) return
      if (corpusFilter && !corpusFilter.test(expected.cmd)) return
      it(expected.cmd, async () => {
        const fs = kernel.filesystem.fs
        const dir = `/tmp/gnut/c${index}`
        await fs.mkdir(`${dir}/dir`, { recursive: true })
        for (const [name, data] of Object.entries(buffers)) await fs.writeFile(`${dir}/${name}`, data as Uint8Array)
        await kernel.shell.execute(`cd ${dir}; { ${expected.cmd}\n} > /tmp/gnut/o${index} 2> /tmp/gnut/e${index} < /dev/null; echo $? > /tmp/gnut/s${index}`)
        const code = Number((await fs.readFile(`/tmp/gnut/s${index}`, 'utf8')).trim())
        const out = latin1(await fs.readFile(`/tmp/gnut/o${index}`))
        const err = latin1(await fs.readFile(`/tmp/gnut/e${index}`))
        // the directory these files pile up in slows every later case down, so nothing is left behind
        await Promise.all([dir, `/tmp/gnut/o${index}`, `/tmp/gnut/e${index}`, `/tmp/gnut/s${index}`].map(path => fs.rm(path, { recursive: true, force: true })))
        if (reportFile) {
          nodeFs.appendFileSync(reportFile, JSON.stringify({ index, cmd: expected.cmd, out, code, err }) + '\n')
          return
        }
        const accepted = known[expected.cmd]
        if (accepted) expect({ out, code }, accepted.reason).toEqual({ out: accepted.out, code: accepted.code })
        else expect({ out, code }).toEqual({ out: expected.out, code: expected.code })
      }, 60000)
    })
  })
}

// Keeps the corpus and the golden file from drifting apart
describe('the text tool corpus', () => {
  it('has a golden result for every command', () => {
    expect((golden as Golden[]).map(entry => entry.cmd)).toEqual(cases)
  })
})
