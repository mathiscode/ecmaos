/**
 * Real `execve`'d `snake`: a game that owns the terminal. Raw-mode keys come from the tty (arrow
 * keys steer, Escape or ^C quits) and each frame is one `poll()` on the tty with a timeout, so the
 * game loop is plain synchronous code in its worker. The high score lives in `$HOME/.snake-high-score`
 * (it used to be a `localStorage` key, which a worker cannot reach).
 */
import { decodeKeys, rawMode, ttyFd } from '../../../../utils/src/commands-execve/lib/tty.mjs'

const { argv, env, exit, write, read, open, close, poll, POLLIN, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, onSignal } = globalThis.ecmaosSyscalls

const usage = `Usage: snake
Play a simple snake game. Arrow keys steer; Escape or ^C quits.

  --help  display this help and exit`

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const out = text => write(1, encoder.encode(text))

const WIDTH = 20
const HEIGHT = 10
const TICK_MS = 150
const SIGINT = 2

const yellow = text => `\x1b[33m${text}\x1b[0m`
const gray = text => `\x1b[90m${text}\x1b[0m`
const green = text => `\x1b[32m${text}\x1b[0m`
const blue = text => `\x1b[34m${text}\x1b[0m`

const scorePath = () => (env['HOME'] ? `${env['HOME']}/.snake-high-score` : '')

function loadHighScore() {
  const path = scorePath()
  if (!path) return 0
  try {
    const fd = open(path, O_RDONLY)
    try {
      const buffer = new Uint8Array(32)
      const n = read(fd, buffer, -1)
      return Number(decoder.decode(buffer.subarray(0, Math.max(n, 0)))) || 0
    } finally {
      close(fd)
    }
  } catch {
    return 0
  }
}

function saveHighScore(score) {
  const path = scorePath()
  if (!path) return
  try {
    const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    try {
      write(fd, encoder.encode(String(score)))
    } finally {
      close(fd)
    }
  } catch {
    // an unwritable home just means the score is not remembered
  }
}

function play(tty) {
  const snake = [{ x: 10, y: 5 }]
  let food = { x: 15, y: 5 }
  let direction = { x: 1, y: 0 }
  let score = 0
  let highScore = loadHighScore()
  let gameOver = false
  let started = false
  let interrupted = false

  onSignal(SIGINT, () => { interrupted = true })

  const render = () => {
    const board = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(' '))
    snake.forEach((segment, i) => { board[segment.y][segment.x] = i === 0 ? yellow('█') : gray('█') })
    board[food.y][food.x] = green('●')

    let frame = '\x1b[2J\x1b[2;1H'
    frame += blue('┌' + '─'.repeat(WIDTH) + '┐') + '\n'
    for (const row of board) frame += blue('│' + row.join('') + '│') + '\n'
    frame += blue(`└${'─'.repeat(WIDTH)}┘`) + '\n'
    frame += `Score: ${score}  High Score: ${highScore}\n`
    if (!started) frame += '\nPress any key to start...\n'
    out(frame)
  }

  const step = () => {
    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y }
    if (head.x < 0 || head.x >= WIDTH || head.y < 0 || head.y >= HEIGHT) { gameOver = true; return }
    if (snake.some(segment => segment.x === head.x && segment.y === head.y)) { gameOver = true; return }

    snake.unshift(head)
    if (head.x === food.x && head.y === food.y) {
      score++
      food = { x: Math.floor(Math.random() * WIDTH), y: Math.floor(Math.random() * HEIGHT) }
      if (score > highScore) {
        highScore = score
        saveHighScore(highScore)
      }
    } else snake.pop()
  }

  const steer = key => {
    const next = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowRight: { x: 1, y: 0 }, ArrowLeft: { x: -1, y: 0 } }[key]
    if (next && !(next.x + direction.x === 0 && next.y + direction.y === 0)) direction = next
    if (key === 'Escape') gameOver = true
    started = true
  }

  render()
  let nextTick = performance.now() + TICK_MS
  while (!gameOver && !interrupted) {
    const wait = Math.max(0, nextTick - performance.now())
    let ready = 0
    try {
      ;[ready] = poll([{ fd: tty, events: POLLIN }], wait)
    } catch (error) {
      if (error?.code !== 'EINTR') throw error
    }

    if (ready & POLLIN) {
      const buffer = new Uint8Array(64)
      const n = read(tty, buffer, -1)
      if (n <= 0) break
      for (const key of decodeKeys(buffer.subarray(0, n))) steer(key)
    }

    if (performance.now() >= nextTick) {
      nextTick += TICK_MS
      if (started) {
        step()
        render()
      }
    }
  }
}

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help' || args[0] === '-h') {
    write(2, encoder.encode(usage + '\n'))
    return 0
  }

  const tty = ttyFd()
  if (tty < 0) {
    write(2, encoder.encode('snake: not a terminal\n'))
    return 1
  }

  const restore = rawMode(tty)
  out('\x1b[?25l')
  try {
    play(tty)
  } finally {
    restore()
    out('Game Over!\n\x1b[?25h')
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  out('\x1b[?25h')
  write(2, encoder.encode(`snake: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
