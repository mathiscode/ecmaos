import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import corpusText from './fixtures/shell-parity.corpus.txt?raw'
import golden from './fixtures/shell-parity.golden.json'
import { FS_PREAMBLE, parseCorpus } from './fixtures/shell-parity'
import { knownEcmash, knownKernel, type KnownTable } from './fixtures/shell-parity.known'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The same scripts through the kernel shell and through `/bin/ecmash`, each checked against what real
 * bash printed (`fixtures/shell-parity.golden.json`). A divergence is listed in
 * `fixtures/shell-parity.known.ts` with its actual output; it is pinned there, so a fix has to remove
 * the entry. Set `PARITY_DISCOVER=1` to get every mismatch as one JSON blob in a thrown error, which
 * is how the known tables are first filled in.
 */
const only = process.env['PARITY_ONLY'] ? new RegExp(process.env['PARITY_ONLY']) : undefined
const cases = parseCorpus(corpusText).filter(test => !only || only.test(test.id))
const expected = golden as Record<string, { stdout: string, status: number }>

interface Outcome { stdout: string, status: number }

describe('shell parity with bash', () => {
  let kernel: Kernel
  let baseline: Map<string, string>

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
    baseline = new Map(kernel.shell.env)
  }, 60000)

  const fs = () => kernel.filesystem.fs

  /** Puts the kernel shell back to a fresh state, since it keeps variables and functions between runs. */
  const resetKernelShell = () => {
    const shell = kernel.shell
    shell.functions.clear()
    shell.aliases.clear()
    shell.arrays.clear()
    shell.env.clear()
    for (const [name, value] of baseline) shell.env.set(name, value)
    shell.cwd = '/'
    for (const option of ['errexit', 'nounset', 'pipefail', 'xtrace', 'noglob', 'noclobber', 'verbose'] as const) shell.applyShellOption(option, false)
    for (const [signal] of shell.listTraps()) shell.setTrap(undefined, signal)
    shell.clearPositionalParameters()
    const internals = shell as unknown as { _execOutputs?: unknown, _interrupted: boolean, _jobs: unknown[], _nextJobId: number }
    shell.state.readonlyNames.clear()
    shell.state.unexported.clear()
    shell.state.integerNames.clear()
    shell.state.namerefNames.clear()
    shell.state.shopts.clear()
    shell.state.unsetArray('FUNCNAME')
    internals._execOutputs = undefined
    internals._interrupted = false
    // `wait` reports the jobs of earlier cases too, including ones that failed.
    internals._jobs.length = 0
    internals._nextJobId = 1
  }

  // Each run gets its own output files: a pipeline stage that outlives its case would otherwise write
  // into the next case's output.
  let serial = 0

  const viaKernel = async (script: string): Promise<Outcome> => {
    resetKernelShell()
    const out = `/tmp/pk-out-${serial++}`
    // `exec >` redirects the shell itself, so the whole script is captured, EXIT trap included.
    const status = await kernel.shell.executeScriptText(`exec > ${out} 2> ${out}.err; ${script}`)
    const stdout = await fs().readFile(out, 'utf-8').catch(() => '')
    return { stdout, status }
  }

  const viaEcmash = async (script: string): Promise<Outcome> => {
    resetKernelShell()
    const base = `/tmp/pe-${serial++}`
    await fs().writeFile(`${base}-script`, script)
    const status = await kernel.shell.execute(`ecmash ${base}-script > ${base}-out 2> ${base}-err`)
    return { stdout: await fs().readFile(`${base}-out`, 'utf-8'), status }
  }

  const run = (shell: 'kernel' | 'ecmash', test: { script: string, fs: boolean }) => {
    const script = (test.fs ? FS_PREAMBLE : '') + test.script
    // An exception out of the shell is a result too, recorded the way discovery records it.
    const outcome = (shell === 'kernel' ? viaKernel(script) : viaEcmash(script))
      .catch((error): Outcome => ({ stdout: `THREW ${error instanceof Error ? error.message : String(error)}`, status: -1 }))
    // A script that waits forever (on stdin, on a pipe) must be a result, not a stuck run.
    return Promise.race([outcome, new Promise<Outcome>(resolve => setTimeout(() => resolve({ stdout: 'TIMEOUT', status: -2 }), 8000))])
  }

  if (process.env['PARITY_DISCOVER']) {
    it('discovers every mismatch', async () => {
      const found: Record<string, Record<string, Outcome>> = { kernel: {}, ecmash: {} }
      for (const test of cases) {
        for (const shell of ['kernel', 'ecmash'] as const) {
          const outcome = await run(shell, test)
          const want = expected[test.id] as Outcome
          if (outcome.stdout !== want.stdout || outcome.status !== want.status) (found[shell] as Record<string, Outcome>)[test.id] = outcome
        }
      }
      throw new Error('DISCOVERY' + JSON.stringify(found) + 'ENDDISCOVERY')
    }, 900000)
    return
  }

  for (const [shell, known] of [['kernel', knownKernel], ['ecmash', knownEcmash]] as Array<['kernel' | 'ecmash', KnownTable]>) {
    describe(shell, () => {
      for (const test of cases) {
        const divergence = known[test.id]
        it(divergence ? `${test.id} (known: ${divergence.why})` : test.id, async () => {
          const want = expected[test.id] as Outcome
          const got = await run(shell, test)
          if (divergence) {
            // Pinned: the shell does this today. If it now matches bash, delete the known entry.
            expect({ stdout: got.stdout, status: got.status }).toEqual({ stdout: divergence.stdout, status: divergence.status })
            expect(got.stdout !== want.stdout || got.status !== want.status).toBe(true)
          } else {
            expect(got).toEqual(want)
          }
        }, 30000)
      }
    })
  }
})
