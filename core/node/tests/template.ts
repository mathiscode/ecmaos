import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const bundle = path.resolve(import.meta.dirname, '../dist/ecmaos.mjs')
const fixtures = path.resolve(import.meta.dirname, 'fixtures')

/** Where the template keeps the test programs, ready to `cp` */
export const FixtureDir = '/usr/share/ecmaos-test'

/**
 * A machine that has booted once, so a session starts from it as a restart would. A new data folder makes the first boot
 * unpack the initfs and install the programs, which keeps the process busy for five seconds after the prompt appears; with
 * every test starting a machine of its own that is most of what the suite spends. The test programs of `fixtures/` are put
 * in it as well, which typing them into a machine at a terminal would otherwise repeat in every test that runs one.
 * It is made once per build of the bundle and each session gets a copy.
 */
export function bootedTemplate() {
  const { mtimeMs, size } = statSync(bundle)
  const wasm = readdirSync(fixtures).filter(name => name.endsWith('.wasm')).sort()
  // the bundle and the programs put in it both decide what the template holds
  const programs = wasm.map(name => statSync(path.join(fixtures, name)).size).join('.')
  const template = path.join(tmpdir(), `ecmaos-template-${Math.round(mtimeMs)}-${size}-${programs}`)
  if (existsSync(template)) return template
  const building = mkdtempSync(`${template}-building-`)
  // The prompt comes before the programs are installed, and that is the last of the first boot: wait for its log line, then
  // put the test programs in, then halt
  const script = `
    import { spawn } from 'node:child_process'
    import { readFileSync } from 'node:fs'
    const child = spawn(process.execPath, [${JSON.stringify(bundle)}], { env: { ...process.env, ECMAOS_DATA: ${JSON.stringify(building)} } })
    let out = ''
    const timer = setTimeout(() => { console.error(out); process.exit(1) }, 100000)
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { out += data })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const prompts = () => out.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '').split('root:/root# ').length
    const run = async command => {
      const before = prompts()
      child.stdin.write(command + '\\r')
      while (prompts() <= before) await sleep(20)
    }
    while (!out.includes('Installed programs:')) await sleep(50)
    await run('mkdir -p ${FixtureDir}')
    for (const name of ${JSON.stringify(wasm)}) {
      const encoded = readFileSync(${JSON.stringify(fixtures + '/')} + name).toString('base64')
      const target = '${FixtureDir}/' + name
      for (let at = 0; at < encoded.length; at += 1500) await run('echo ' + encoded.slice(at, at + 1500) + ' >> ' + target + '.b64')
      await run('base64 -d ' + target + '.b64 > ' + target + '; chmod 755 ' + target + '; rm ' + target + '.b64')
    }
    child.on('exit', code => { clearTimeout(timer); process.exit(code === 0 ? 0 : 1) })
    child.stdin.write('halt\\r')
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 150_000, encoding: 'utf8' })
  if (result.status !== 0) {
    rmSync(building, { recursive: true, force: true })
    throw new Error(`could not make the booted template: exit ${result.status}\n${result.stdout}${result.stderr}`)
  }
  try { renameSync(building, template) } catch { rmSync(building, { recursive: true, force: true }) } // another run got there first
  return template
}

/** A new data folder that holds a copy of the template: a machine that has booted before, for a test that names its own folder */
export function copyOfTemplate(prefix = 'ecmaos-data-') {
  const folder = mkdtempSync(path.join(tmpdir(), prefix))
  cpSync(bootedTemplate(), folder, { recursive: true })
  return folder
}
