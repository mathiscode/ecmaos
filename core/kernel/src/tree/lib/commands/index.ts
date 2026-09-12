/**
 * Kernel-native legacy commands -- the dozen commands that live in `@ecmaos/kernel` itself rather
 * than `@ecmaos/coreutils`, because their real logic reaches kernel-only state (`kernel.storage`,
 * `kernel.processes`, `kernel.screensavers`, `kernel.events`) or real DOM APIs (`download`/`upload`/
 * `snake`'s `document.createElement`/`FileReader`/`onKey`). None of these are `execve`'d yet -- they
 * still run as in-process `TerminalCommand` closures, exactly like `@ecmaos/coreutils`'s own legacy
 * commands, via the same lazy, per-`Terminal`-cached shim (`resolveLegacyCommand`, in
 * `@ecmaos/coreutils`'s `shared/legacy-command-shim.ts`) -- `getKernelLegacyCommands()` below is
 * this package's own source list for that shim to draw from.
 *
 * `export` and `su` used to live here too, each closing over `kernel`/`shell`/`terminal` the same
 * way. Both were reclassified as true shell builtins (they mutate the *calling shell's own* live
 * state -- `shell.env`/`globalThis.process.env` for `export`, `shell.context`/`shell.credentials`
 * for `su` -- exactly the reason bash keeps these as permanent special builtins, never forked). Their
 * real implementations moved to `#lib/shell-builtins.ts`, dispatched directly by `Shell.execute`
 * before any file-based command resolution happens at all; nothing in this file references them
 * anymore.
 *
 * `clear`, `df`, `ps`, `reboot` used to live here too. All four turned out to be portable to real
 * `execve` after all -- each is either pure stdout formatting (`clear`) or a single read-only (or,
 * for `reboot`, side-effecting-but-argument-less) call into kernel-only state, reachable from a real
 * worker through a small custom syscall (`storage_usage`/`ps_list`/`reboot`, added to
 * `#lib/main-thread-syscalls.ts` following the exact `window_create` precedent). Their real
 * implementations moved to `src/bin/commands/{clear,df,ps,reboot}.mjs`; nothing in this file
 * references them anymore.
 *
 * `uninstall` used to live here too (`./uninstall.ts`). Unlike `install` (still blocked on
 * `kernel.filesystem.extractTarball` plus recursive `shell.execute()` calls for pre/postinstall
 * scripts and dependencies), `uninstall` only ever reads a directory, reads/parses one
 * `package.json`, and unlinks/removes real files -- all plain filesystem syscalls, no kernel-only
 * state and no custom syscall needed at all. Its real implementation moved to
 * `src/bin/commands/uninstall.mjs`; nothing in this file references it anymore.
 */

import ansi from 'ansi-escape-sequences'
import chalk from 'chalk'
import type { CommandLineOptions } from 'command-line-args'
import path from 'path'

import { KernelEvents } from '@ecmaos/types'
import type { Kernel, Process, Shell, Terminal } from '@ecmaos/types'

import { TerminalCommand, type CommandArgs, type CreateCommandFn, type LegacyCommands, writelnStdout, writelnStderr } from '@ecmaos/coreutils'

const HelpOption = { name: 'help', type: Boolean, description: 'Display help' }

function createDownload(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'download', description: 'Download a file from the filesystem', kernel, shell, terminal,
    options: [
      HelpOption,
      { name: 'path', type: String, typeLabel: '{underline path}', defaultOption: true, multiple: true, description: 'The path(s) to the file(s) to download' }
    ],
    run: async (argv: CommandLineOptions, process?: Process) => download({ kernel, shell, terminal, process, args: argv.path })
  })
}

function createInstall(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'install', description: 'Install a package', kernel, shell, terminal,
    options: [
      HelpOption,
      { name: 'package', type: String, typeLabel: '{underline package}', defaultOption: true, description: 'The package name and optional version (e.g. package@1.0.0)' },
      { name: 'registry', type: String, description: 'The registry to use', defaultValue: 'https://registry.npmjs.org' },
      { name: 'reinstall', type: Boolean, description: 'Reinstall the package if it is already installed' }
    ],
    run: async (argv: CommandLineOptions) => {
      const { default: install } = await import('./install')
      return install({ kernel, shell, terminal, args: [argv.package, argv.registry, argv.reinstall] })
    }
  })
}

function createLoad(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'load', description: 'Load a JavaScript file', kernel, shell, terminal,
    options: [HelpOption, { name: 'path', type: String, typeLabel: '{underline path}', defaultOption: true, description: 'The path to the file to load' }],
    run: async (argv: CommandLineOptions) => load({ kernel, shell, terminal, args: [argv.path] })
  })
}

function createPasswd(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'passwd', description: 'Change user password', kernel, shell, terminal,
    options: [HelpOption, { name: 'password', type: String, multiple: true, defaultOption: true, description: 'Old and new passwords (optional - will prompt if not provided)' }],
    run: async (argv: CommandLineOptions, process?: Process) => passwd({ kernel, shell, terminal, process, args: argv.password })
  })
}

function createScreensaver(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'screensaver', description: 'Start the screensaver', kernel, shell, terminal,
    options: [
      HelpOption,
      { name: 'screensaver', type: String, typeLabel: '{underline screensaver}', defaultOption: true, description: 'The screensaver to start' },
      { name: 'set', type: Boolean, description: 'Set the default screensaver' }
    ],
    run: async (argv: CommandLineOptions, process?: Process) => screensaver({ kernel, shell, terminal, process, args: [argv.screensaver, argv.set] })
  })
}

function createSnake(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'snake', description: 'Play a simple snake game', kernel, shell, terminal, options: [],
    run: async () => { await snake({ kernel, shell, terminal, args: [] }) }
  })
}

function createUpload(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'upload', description: 'Upload files to the filesystem', kernel, shell, terminal,
    options: [HelpOption, { name: 'path', type: String, typeLabel: '{underline path}', defaultOption: true, description: 'The path to store the file' }],
    run: async (argv: CommandLineOptions, process?: Process) => upload({ kernel, shell, terminal, process, args: argv.path ? [argv.path] : [] })
  })
}

/** This package's own legacy-shim source list -- see module doc comment. Merged with
 * `@ecmaos/coreutils`'s `getLegacyCommands()` by `Kernel.registerCommands`/`executeCommand`. */
export function getKernelLegacyCommands(): LegacyCommands {
  const entries: Array<[string, string, CreateCommandFn]> = [
    ['download', 'Download a file from the filesystem', createDownload],
    ['install', 'Install a package', createInstall],
    ['load', 'Load a JavaScript file', createLoad],
    ['passwd', 'Change user password', createPasswd],
    ['screensaver', 'Start the screensaver', createScreensaver],
    ['snake', 'Play a simple snake game', createSnake],
    ['upload', 'Upload files to the filesystem', createUpload]
  ]

  return Object.fromEntries(entries.map(([name, description, createCommand]) => [name, { description, createCommand }]))
}

// Re-export TerminalCommand and CommandArgs for backward compatibility
export { TerminalCommand, type CommandArgs } from '@ecmaos/coreutils'

// Kernel-specific command implementations

export const download = async ({ shell, terminal, process, args }: CommandArgs) => {
  const destination = (args as string[])[0]
  const fullPath = destination ? path.resolve(shell.cwd, destination) : shell.cwd
  if (await shell.context.fs.promises.exists(fullPath)) {
    const data = await shell.context.fs.promises.readFile(fullPath)
    const blob = new Blob([new Uint8Array(data)], { type: 'application/octet-stream' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')

    a.href = url
    a.download = path.basename(fullPath)
    a.click()
    window.URL.revokeObjectURL(url)
  } else {
    await writelnStderr(process, terminal, chalk.red(`${fullPath} not found`))
  }
}

export const load = async ({ shell, args }: CommandArgs) => {
  const [target] = (args as string[])
  if (!target) {
    await shell.execute('load --help')
    return 1
  }

  const fullPath = path.resolve(shell.cwd, target)
  const code = await shell.context.fs.promises.readFile(fullPath, 'utf-8')
  const script = new Function(code)
  script()
}

export const passwd = async ({ kernel, terminal, process, args }: CommandArgs) => {
  let oldPass, newPass

  if (!args || !Array.isArray(args) || args.length < 2) {
    oldPass = await terminal.readline(chalk.cyan('Enter current password: '), true)
    if (!oldPass) {
      await writelnStderr(process, terminal, chalk.red('Current password required'))
      return 1
    }

    newPass = await terminal.readline(chalk.cyan('Enter new password: '), true)
    if (!newPass) {
      await writelnStderr(process, terminal, chalk.red('New password required'))
      return 1
    }

    const confirmPass = await terminal.readline(chalk.cyan('Confirm new password: '), true)
    if (newPass !== confirmPass) {
      await writelnStderr(process, terminal, chalk.red('Passwords do not match'))
      return 1
    }
  } else {
    [oldPass, newPass] = args as string[]
  }

  try {
    if (!oldPass || !newPass) throw new Error('Missing password')
    await kernel.users.password(oldPass, newPass)
    await writelnStdout(process, terminal, chalk.green('Password updated successfully'))
    return 0
  } catch (error) {
    await writelnStderr(process, terminal, chalk.red(`Failed to update password: ${error instanceof Error ? error.message : 'Unknown error'}`))
    return 1
  }
}

export const screensaver = async ({ kernel, terminal, process, args }: CommandArgs) => {
  const [screensaverName, set] = (args as string[])

  if (screensaverName === 'off') {
    kernel.storage.local.removeItem('screensaver')
    return 0
  }

  let saverName = screensaverName
  if (!saverName) saverName = kernel.storage.local.getItem('screensaver') || 'matrix'

  const saver = kernel.screensavers.get(saverName)
  if (!saver) {
    await writelnStderr(process, terminal, chalk.red('Invalid screensaver'))
    return 1
  }

  terminal.blur()
  saver.default({ terminal })

  if (set) kernel.storage.local.setItem('screensaver', saverName)
}

export const snake = ({ kernel, terminal }: CommandArgs) => {
  const width = 20
  const height = 10
  const snake = [{ x: 10, y: 5 }]
  let food = { x: 15, y: 5 }
  let direction = { x: 1, y: 0 }
  let score = 0
  let gameOver = false
  let gameStarted = false

  const renderGame = () => {
    const gameBoard = Array(height).fill(null).map(() => Array(width).fill(' '))
    snake.forEach(segment => gameBoard[segment.y]![segment.x] = segment.y === snake[0]!.y && segment.x === snake[0]!.x ? chalk.yellow('█') : chalk.gray('█'))
    gameBoard[food.y]![food.x] = chalk.green('●')

    terminal.write(ansi.erase.display(2) + ansi.cursor.position(2, 1))
    terminal.writeln(chalk.blue('┌' + '─'.repeat(width) + '┐'))
    gameBoard.forEach(row => terminal.writeln(chalk.blue('│' + row.join('') + '│')))
    terminal.writeln(chalk.blue(`└${'─'.repeat(width)}┘`))
    terminal.writeln(`Score: ${score}  High Score: ${kernel.storage.local.getItem('snake-high-score') || 0}`)
    if (!gameStarted) terminal.writeln('\nPress any key to start...')
  }

  const moveSnake = () => {
    const head = { x: snake[0]!.x + direction.x, y: snake[0]!.y + direction.y }
    if (head.x < 0 || head.x >= width || head.y < 0 || head.y >= height) return gameOver = true
    if (snake.some(segment => segment.x === head.x && segment.y === head.y)) return gameOver = true

    snake.unshift(head)

    if (head.x === food.x && head.y === food.y) {
      score++
      food = { x: Math.floor(Math.random() * width), y: Math.floor(Math.random() * height) }
      if (!kernel.storage.local.getItem('snake-high-score') || Number(kernel.storage.local.getItem('snake-high-score')) < score)
        kernel.storage.local.setItem('snake-high-score', score.toString())
    } else snake.pop()

    return
  }

  terminal.write(ansi.cursor.hide)
  terminal.unlisten()
  renderGame()

  const keyListener = terminal.onKey(({ domEvent }: { domEvent: KeyboardEvent }) => {
    const newDirection = (() => {
      switch (domEvent.key) {
        case 'ArrowUp': return { x: 0, y: -1 }
        case 'ArrowDown': return { x: 0, y: 1 }
        case 'ArrowRight': return { x: 1, y: 0 }
        case 'ArrowLeft': return { x: -1, y: 0 }
        default: return null
      }
    })()

    if (newDirection && !(newDirection.x + direction.x === 0 && newDirection.y + direction.y === 0)) direction = newDirection
    if (domEvent.key === 'Escape') gameOver = true

    if (!gameStarted) {
      gameStarted = true
      switch (domEvent.key) {
        case 'ArrowUp': return direction = { x: 0, y: -1 }
        case 'ArrowDown': return direction = { x: 0, y: 1 }
        case 'ArrowRight': return direction = { x: 1, y: 0 }
        case 'ArrowLeft': return direction = { x: -1, y: 0 }
      }
    }
  })

  const gameLoop = setInterval(() => {
    if (gameOver) {
      keyListener.dispose()
      terminal.listen()
      clearInterval(gameLoop)
      terminal.writeln('Game Over!')
      terminal.write(ansi.cursor.show + terminal.prompt())
      return
    }

    if (!gameStarted) return

    moveSnake()
    renderGame()
  }, 150)

  return new Promise(resolve => {
    const checkGameOver = setInterval(() => {
      if (gameOver) { clearInterval(checkGameOver); resolve(0) }
    }, 100)
  })
}

export const upload = async ({ kernel, shell, terminal, process, args }: CommandArgs) => {
  const destinationPath = (args as string[])[0]
  const baseDestination = destinationPath ? path.resolve(shell.cwd, destinationPath) : shell.cwd

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '*'
  input.multiple = true
  input.onchange = async (event) => {
    if (!event.target) {
      await writelnStderr(process, terminal, chalk.red('No file selected'))
      return
    }
    const files = (event.target as HTMLInputElement).files
    if (!files) {
      await writelnStderr(process, terminal, chalk.red('No file selected'))
      return
    }

    for (const file of files) {
      const fileReader = new FileReader()
      fileReader.onload = async (event) => {
        if (!event.target) {
          await writelnStderr(process, terminal, chalk.red('Failed to read file'))
          return
        }
        try {
          const data = new Uint8Array(event.target.result as ArrayBuffer)
          const destination = path.resolve(baseDestination, file.name)
          await shell.context.fs.promises.writeFile(destination, data)
          kernel.events.dispatch(KernelEvents.UPLOAD, { file: file.name, path: destination })
        } catch (error) {
          await writelnStderr(process, terminal, chalk.red(`Failed to upload ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`))
        }
      }

      fileReader.onerror = async () => {
        await writelnStderr(process, terminal, chalk.red(`Failed to read file: ${file.name}`))
      }

      fileReader.readAsArrayBuffer(file)
    }
  }

  input.click()
  return 0
}
