import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ptyHost = path.resolve(import.meta.dirname, 'pty-host.py')
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
  private _temp?: string

  /** The data directory this process keeps its machine in */
  readonly dataDir: string

  get output() { return stripAnsi(this._out) }
  get exit() { return this._exit }

  /**
   * With `pty`, the bundle runs on a pseudo-terminal of that size (through `pty-host.py`), so it sees a real TTY: raw
   * mode, a window size, escape sequences. Without, it is fed through pipes.
   */
  constructor(args: string[] = ['--quiet'], options: { cwd?: string, env?: NodeJS.ProcessEnv, pty?: { cols: number, rows: number } } = {}) {
    // Every session gets a machine of its own, so nothing is written into the working tree
    const given = (options.env ?? process.env)['ECMAOS_DATA']
    if (!given) this._temp = mkdtempSync(path.join(tmpdir(), 'ecmaos-test-'))
    this.dataDir = given ?? this._temp!
    const env = { ...(options.env ?? process.env), ECMAOS_DATA: this.dataDir }
    this._child = options.pty
      ? spawn('python3', [ptyHost, String(options.pty.cols), String(options.pty.rows), process.execPath, bundle, ...args], { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
      : spawn(process.execPath, [bundle, ...args], { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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

  /** Sends raw bytes, as typed (`\x1b[A` is the up arrow) */
  send(data: string) { this._child.stdin.write(data) }

  /** Closes the input, after an optional last line: what a script ending looks like to the process */
  end(last?: string) { this._child.stdin.end(last === undefined ? undefined : `${last}\r`) }

  /** Sends a signal to the process */
  signal(signal: NodeJS.Signals) { this._child.kill(signal) }

  /** Resolves once the process has exited */
  async waitForExit(timeout = 15_000) {
    await this.until(() => !!this._exit, 'the process to exit', timeout)
  }

  /** Changes the size of the pseudo-terminal (`pty` only) */
  resize(cols: number, rows: number) { (this._child.stdio[3] as NodeJS.WritableStream).write(`resize ${cols} ${rows}\n`) }

  /** Resolves once the output (escape sequences removed) contains `text` after position `from` */
  async waitFor(text: string, from = 0, timeout = 10_000) {
    await this.until(() => this.output.indexOf(text, from) !== -1, `"${text}"`, timeout)
  }

  async stop() {
    if (!this._exit) {
      this._child.kill('SIGKILL')
      await new Promise(resolve => this._child.once('exit', resolve))
    }
    if (this._temp) rmSync(this._temp, { recursive: true, force: true })
  }
}
