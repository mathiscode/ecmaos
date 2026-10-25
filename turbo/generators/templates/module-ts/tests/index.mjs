import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

execFileSync('node', ['build.mjs'], { stdio: 'inherit' })
const { name } = JSON.parse(readFileSync('module.json', 'utf8'))
const file = `dist/${name}.ko.mjs`
assert.ok(readFileSync(file, 'utf8').startsWith('/* ecmaos-module\n'), 'the file starts with the modinfo')

const logs = []
const procs = {}
const module = (await import(new URL(`../${file}`, import.meta.url))).default
await module.init({ log: { info: line => logs.push(line) }, proc: (path, spec) => { procs[path] = spec } })
assert.ok(logs.length, 'init logs')
assert.ok(procs[name].show().includes('hello'), 'init adds the /proc file')
console.log('ok')
