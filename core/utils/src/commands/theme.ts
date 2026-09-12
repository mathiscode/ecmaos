import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { ThemePresets } from '@ecmaos/types'
import { parse, stringify } from 'smol-toml'
import path from 'path'

function printUsage(io: CommandIO): void {
  const usage = `Usage: theme [OPTION]... [THEME_NAME]
List or switch themes.

  -s, --save    save the theme to ~/.config/shell.toml
  -h, --help    display this help and exit`
  io.writelnErr(usage)
}

export const meta = { command: 'theme', description: 'List or switch themes' } as const

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    ...meta,
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      let save = false
      let themeName: string | undefined

      for (const arg of ctx.argv) {
        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '--save' || arg === '-s') {
          save = true
        } else if (!arg.startsWith('-')) {
          themeName = arg
        }
      }

      // List themes if no theme name provided
      if (!themeName) {
        const themes = Object.keys(ThemePresets).sort().join('\n')
        await io.writeln(themes)
        return 0
      }

      // Check if theme exists
      // The shell's setTheme also handles custom theme objects, but for this CLI we only support presets
      if (!ThemePresets[themeName]) {
        // Try strict case matching first, then case-insensitive
        const match = Object.keys(ThemePresets).find(t => t.toLowerCase() === themeName!.toLowerCase())
        if (match) {
          themeName = match
        } else {
          await io.writelnErr(`Theme '${themeName}' not found`)
          return 1
        }
      }

      // Apply theme
      try {
        shell.config.setTheme(themeName)
        await io.writeln(`Switched to theme: ${themeName}`)
      } catch (error) {
        await io.writelnErr(`Failed to switch theme: ${error}`)
        return 1
      }

      // Save if requested
      if (save) {
        try {
          const home = shell.env.get('HOME')
          if (!home) {
             await io.writelnErr('HOME environment variable not set, cannot save config')
             return 1
          }

          const configDir = path.join(home, '.config')
          if (!await shell.context.fs.promises.exists(configDir)) {
            await shell.context.fs.promises.mkdir(configDir, { recursive: true })
          }

          const configPath = path.join(configDir, 'shell.toml')
          let config: any = {}

          if (await shell.context.fs.promises.exists(configPath)) {
            const content = await shell.context.fs.promises.readFile(configPath, 'utf-8')
            try {
              config = parse(content)
            } catch (e) {
              await io.writelnErr(`Warning: Failed to parse existing config, creating new one`)
            }
          }

          // Update theme section
          config.theme = config.theme || {}
          config.theme.name = themeName

          // Write back
          // Note: smol-toml stringify might be limited, but for this simple case it should work. 
          // If the existing toml is complex, we might lose comments/formatting. 
          // shell.ts uses smol-toml for parsing.
          const newContent = stringify(config)
          await shell.context.fs.promises.writeFile(configPath, newContent)
          
          await io.writeln(`Theme saved to ${configPath}`)

        } catch (error) {
           await io.writelnErr(`Failed to save config: ${error}`)
           return 1
        }
      }

      return 0
    }
  })
}
