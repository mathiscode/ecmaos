/**
 * Real `execve`'d `theme` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/theme.ts`) per this session's M1 pass. `shell.config.setTheme()` mutates
 * live `Shell`/`Terminal` state (and immediately calls `terminal.updateConfig()`), reached through
 * the new `shell_set_theme` custom syscall (`#lib/main-thread-syscalls.ts`). Listing presets is plain
 * data work needing no syscall at all -- `ThemePresets` is a plain data object, imported here the
 * same way the legacy command imported it.
 *
 * Every successful switch is persisted to `~/.config/shell.toml` -- this used to be opt-in behind a
 * `--save`/`-s` flag, but that made the default behavior silently non-persistent across a reload,
 * which is surprising for a shell setting. A failure to persist is reported but doesn't fail the
 * command, since the live switch (the part the user is actually watching happen) already succeeded.
 */

import { join } from './lib/path-utils.mjs'
import { ThemePresets } from '@ecmaos/types'
import { parse, stringify } from 'smol-toml'

const { argv, exit, write, custom, mkdir, stat, open, read, writeAll, close, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: theme [THEME_NAME]
List or switch themes. Switching persists the choice to ~/.config/shell.toml.

  -h, --help    display this help and exit`

function writeStdout(text) { write(1, new TextEncoder().encode(text + '\n')) }
function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }

function exists(path) {
  try { stat(path); return true } catch { return false }
}

function readFile(path) {
  const fd = open(path, O_RDONLY)
  const chunkSize = 65536
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      if (n < chunkSize) break
    }
  } finally {
    close(fd)
  }
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])))
}

function writeFile(path, content) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    writeAll(fd, new TextEncoder().encode(content))
  } finally {
    close(fd)
  }
}

async function main() {
  const args = argv.slice(1)

  let themeName

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      writeStderr(usage)
      return 0
    } else if (!arg.startsWith('-')) {
      themeName = arg
    }
  }

  if (!themeName) {
    writeStdout(Object.keys(ThemePresets).sort().join('\n'))
    return 0
  }

  if (!Object.prototype.hasOwnProperty.call(ThemePresets, themeName)) {
    const match = Object.keys(ThemePresets).find(t => t.toLowerCase() === themeName.toLowerCase())
    if (match) {
      themeName = match
    } else {
      writeStderr(`Theme '${themeName}' not found`)
      return 1
    }
  }

  try {
    await custom('shell_set_theme', themeName)
    writeStdout(`Switched to theme: ${themeName}`)
  } catch (error) {
    writeStderr(`Failed to switch theme: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const home = globalThis.ecmaosSyscalls.env['HOME']
  if (!home) {
    writeStderr('Warning: HOME environment variable not set, theme not persisted')
    return 0
  }

  try {
    const configDir = join(home, '.config')
    if (!exists(configDir)) mkdir(configDir, 0o777)

    const configPath = join(configDir, 'shell.toml')
    let config = {}

    if (exists(configPath)) {
      try {
        config = parse(readFile(configPath))
      } catch {
        writeStderr('Warning: Failed to parse existing config, creating new one')
      }
    }

    config.theme = config.theme || {}
    config.theme.name = themeName

    writeFile(configPath, stringify(config))
  } catch (error) {
    writeStderr(`Warning: failed to persist theme: ${error instanceof Error ? error.message : String(error)}`)
  }

  return 0
}

try {
  exit(await main())
} catch (error) {
  writeStderr(`theme: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
