#!/usr/bin/env node
/**
 * Typecheck error-budget ratchet.
 *
 * Runs `tsc --noEmit` in core/kernel, counts diagnostics, and compares against
 * the budget recorded in .ci/typecheck-baseline.json. The count may drop (which
 * updates the baseline in --write mode) but may never rise.
 *
 * Run this AFTER `pnpm build`. Several workspace packages resolve their types
 * from dist/, so the error surface — and the count — is only stable once the
 * packages that build have populated dist/. The CI workflow enforces this order.
 *
 * Usage:
 *   node scripts/typecheck-ratchet.mjs          # check only; non-zero exit if over budget
 *   node scripts/typecheck-ratchet.mjs --write  # rewrite the baseline to the current count
 *
 * The overhaul carries ~108 pre-existing errors (dual @zenfs/core copies plus
 * third-party vim-wasm sources). Nobody has to fix them all; nobody may add to
 * them. See CONTRIBUTING.md.
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = join(root, '.ci', 'typecheck-baseline.json')
const write = process.argv.includes('--write')

const ERROR_LINE = /: error TS\d+:/

function countErrors() {
  try {
    execSync('npx tsc --noEmit', { cwd: join(root, 'core', 'kernel'), stdio: ['ignore', 'pipe', 'pipe'] })
    return 0
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    if (!out) {
      console.error('ratchet: tsc produced no output; treating as failure')
      process.exit(2)
    }
    return out.split('\n').filter(line => ERROR_LINE.test(line)).length
  }
}

const count = countErrors()
const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))

if (write) {
  writeFileSync(baselineFile, `${JSON.stringify({ ...baseline, budget: count }, null, 2)}\n`)
  console.log(`ratchet: baseline rewritten to ${count}`)
  process.exit(0)
}

if (count > baseline.budget) {
  console.error(`ratchet: FAIL — ${count} typecheck errors, budget is ${baseline.budget} (+${count - baseline.budget})`)
  console.error('Fix the new errors, or if you genuinely reduced the count elsewhere, run with --write and commit the baseline.')
  process.exit(1)
}

if (count < baseline.budget) {
  console.warn(`ratchet: ${count} errors, under the ${baseline.budget} budget by ${baseline.budget - count}.`)
  console.warn('Run `node scripts/typecheck-ratchet.mjs --write` and commit .ci/typecheck-baseline.json to lock in the improvement.')
  process.exit(0)
}

console.log(`ratchet: OK — ${count} errors, exactly at budget`)
