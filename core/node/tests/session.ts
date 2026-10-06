import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

const bundle = path.resolve(import.meta.dirname, '../dist/ecmaos.mjs')
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
const Prompt = 'root:/root# '
// The kernel logs to the terminal at any time (`crond` reports in a moment after the first prompt); that is not command output
const LogLine = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ ecmaos:.*$/

/** A bundled ecmaOS process driven through its stdin and stdout, one command at a time. */
export class Session {
  private _child: ChildProcessWithoutNullStreams
  private _out = ''
  private _exit?: { code: number | null, signal: NodeJS.Signals | null }

  get output() { return stripAnsi(this._out) }
  get exit() { return this._exit }

  constructor(args: string[] = ['--quiet'], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
    this._child = spawn(process.execPath, [bundle, ...args], { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this._child.stdout.on('data', (data: Buffer) => { this._out += data.toString('utf8') })
    this._child.stderr.on('data', (data: Buffer) => { this._out += data.toString('utf8') })
    this._child.on('exit', (code, signal) => { this._exit = { code, signal } })
  }

  private async until(predicate: () => boolean, what: string, timeout: number) {
    const started = Date.now()
    while (!predicate()) {
      if (this._exit) throw new Error(`process exited (${JSON.stringify(this._exit)}) while waiting for ${what}\n${this.output}`)
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}\n${this.output}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  private prompts() { return this.output.split(Prompt).length - 1 }

  /** Resolves once the shell shows its first prompt */
  async ready(timeout = 30_000) {
    await this.until(() => this.prompts() >= 1, 'the first prompt', timeout)
  }

  /** Types a command and returns what it printed, from after the echoed command to the next prompt */
  async run(command: string, timeout = 30_000) {
    const before = this.prompts()
    const mark = this.output.length
    this._child.stdin.write(`${command}\r`)
    await this.until(() => this.prompts() > before, `the prompt after "${command}"`, timeout)
    const lines = this.output.slice(mark).split(Prompt)[0]!.split('\n').filter(line => !LogLine.test(line))
    // the terminal echoes the typed command first
    if (lines[0] === command) lines.shift()
    return lines.join('\n').replace(/\n$/, '')
  }

  async stop() {
    if (!this._exit) {
      this._child.kill('SIGKILL')
      await new Promise(resolve => this._child.once('exit', resolve))
    }
  }
}
