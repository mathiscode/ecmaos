import ansi from 'ansi-escape-sequences'
import { Class } from '@zenfs/linux'
import { controlOperations } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'


export { openGamepadSession, jsEvent, GamepadError } from './session.js'
export type { GamepadDeviceSession, GamepadSessionOptions } from './session.js'

export const pkg = {
  name: 'gamepad',
  version: '0.1.0',
  description: ''
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options
  const usage = `
Usage: /dev/gamepad <command>

Commands:
  list                List connected gamepads
  info <id>           Show information about a specific gamepad
  --help              Show this help message
`

  if (!('getGamepads' in navigator)) {
    terminal.writeln('Gamepad API not available')
    return 1
  }

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  try {
    switch(args[0]) {
      case 'list':
        const gamepads = navigator.getGamepads()
        const connectedPads = Array.from(gamepads).filter(Boolean)

        if (!connectedPads.length) {
          terminal.writeln('No gamepads connected')
          break
        }

        terminal.writeln(`${ansi.style.bold}🎮 Connected Gamepads:${ansi.style.reset}`)
        connectedPads.forEach(gamepad => {
          if (!gamepad) return
          terminal.writeln(`
      🎮 Index: ${ansi.style.cyan}${gamepad.index}${ansi.style.reset}
      📝 ID: ${ansi.style.cyan}${gamepad.id}${ansi.style.reset}
      🔌 Connected: ${ansi.style.cyan}${gamepad.connected}${ansi.style.reset}
      🎯 Buttons: ${ansi.style.cyan}${gamepad.buttons.length}${ansi.style.reset}
      📊 Axes: ${ansi.style.cyan}${gamepad.axes.length}${ansi.style.reset}`)
        })
        break

      case 'info':
        if (!args[1]) {
          terminal.writeln('Please provide a gamepad index')
          return 1
        }
        const gamepads2 = navigator.getGamepads()
        const index = Number(args[1])
        const gamepad = gamepads2[index]

        if (!gamepad) {
          terminal.writeln(`No gamepad found at index ${index}`)
          return 1
        }

        terminal.writeln(`${ansi.style.bold}Gamepad Information:${ansi.style.reset}
      Index: ${gamepad.index}
      ID: ${gamepad.id}
      Connected: ${gamepad.connected}
      Mapping: ${gamepad.mapping}
      Buttons: ${gamepad.buttons.length}
      Axes: ${gamepad.axes.length}`)
        break

      default:
        terminal.writeln(`Unknown command: ${args[0]}`)
        terminal.writeln(usage)
        return 1
    }

    return 0
  } catch (error) {
    terminal.writeln(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** `/sys/class/gamepad` */
const gamepad_class = new Class('gamepad')

/**
 * `/dev/gamepad`, the control node. The pads themselves are the kernel's, where Linux has them: `/dev/input/event<N>` and
 * `/dev/input/js<N>`, made when the browser shows a pad. `session.ts` still serves a pad to another machine (`attach -s`).
 */
export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  return [{ name: 'gamepad', major: 0, minor: 0, class: gamepad_class, ops: controlOperations }]
}
