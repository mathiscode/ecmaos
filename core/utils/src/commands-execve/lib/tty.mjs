/**
 * Terminal helpers for real, worker-hosted programs that drive the terminal themselves (`less`,
 * `man`, `nc`): which fd is the terminal, raw mode, and its size. Built on `tcgetattr`/`tcsetattr`/
 * `winsize`, the real `TCGETS`/`TCSETS`/`TIOCGWINSZ` ioctls `/bin/node` exposes, so what a program
 * sees is the `@zenfs/linux` line discipline's own state, not a private convention.
 */

const { tcgetattr, tcsetattr, winsize } = globalThis.ecmaosSyscalls

// `<asm-generic/termbits.h>` local-mode bits, octal as in the header.
const ISIG = 0o1
const ICANON = 0o2
const ECHO = 0o10

/**
 * The fd that is this program's terminal, or -1 if it has none. Tries stdin, then stderr, then
 * stdout, the way a libc-less `isatty` walk does: `cat file | less` has a pipe on fd 0 but a terminal
 * on fd 2, and `/dev/tty` cannot stand in here because ecmaOS's resolves to the first terminal, not
 * the caller's own.
 */
export function ttyFd() {
  for (const fd of [0, 2, 1]) {
    try {
      tcgetattr(fd)
      return fd
    } catch {
      // ENOTTY: not a terminal, try the next one
    }
  }
  return -1
}

/**
 * Puts the terminal into non-canonical, no-echo mode so each keypress is readable at once, keeping
 * `ISIG` so `^C`/`^Z` still raise signals. Returns a function that restores the previous mode.
 * (`Kernel.executeViaExecve` also restores termios when the process ends, so a program killed
 * mid-session cannot leave the terminal raw; this is for the normal-exit path.)
 */
export function rawMode(fd) {
  const saved = tcgetattr(fd)
  const lflag = saved.lflag
  tcsetattr(fd, { lflag: (lflag & ~(ICANON | ECHO)) | ISIG })
  return () => tcsetattr(fd, { lflag })
}

/** `{ rows, cols }` of the terminal on `fd`, falling back to 24x80 when it cannot say. */
export function terminalSize(fd) {
  try {
    const size = winsize(fd)
    if (size.row > 0 && size.col > 0) return { rows: size.row, cols: size.col }
  } catch {
    // no size: use the classic default below
  }
  return { rows: 24, cols: 80 }
}

/**
 * Decodes one `read()`'s worth of raw terminal bytes into key names. A lone ESC is the Escape key;
 * `ESC [ ...` / `ESC O ...` are the arrow/paging keys xterm sends; anything else is its character.
 * A read returns whatever was waiting, so one call can carry several keys (a paste, key repeat).
 */
export function decodeKeys(bytes) {
  const text = new TextDecoder().decode(bytes)
  const keys = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '\x1b') {
      keys.push(ch === '\r' ? 'Enter' : ch)
      continue
    }
    if (text[i + 1] !== '[' && text[i + 1] !== 'O') {
      keys.push('Escape')
      continue
    }
    let j = i + 2
    while (j < text.length && /[0-9;]/.test(text[j])) j++
    const params = text.slice(i + 2, j)
    const final = text[j] ?? ''
    i = j
    if (final === 'A') keys.push('ArrowUp')
    else if (final === 'B') keys.push('ArrowDown')
    else if (final === 'C') keys.push('ArrowRight')
    else if (final === 'D') keys.push('ArrowLeft')
    else if (final === 'H') keys.push('Home')
    else if (final === 'F') keys.push('End')
    else if (final === '~') {
      const named = { 1: 'Home', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End' }[params.split(';')[0]]
      if (named) keys.push(named)
    }
  }
  return keys
}
