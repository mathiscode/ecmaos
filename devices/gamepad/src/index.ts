import ansi from 'ansi-escape-sequences'
import { Class } from '@zenfs/linux'
import { controlOperations, sessionOperations } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { openGamepadSession } from './session.js'

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

/** How many `js<N>` nodes there are: a browser shows at most four pads at once */
const PadSlots = 4

export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  // Dynamically allocated: real Linux major 13 (input) is now hid's alone, since
  // char_dev.register claims an entire major and the two can no longer share it informally.
  const drivers: KernelCharDevice[] = [{
    name: 'gamepad',
    major: 0,
    minor: 0,
    class: gamepad_class,
    ops: controlOperations
  }]
  if (typeof navigator === 'undefined' || !('getGamepads' in navigator)) return drivers
  // A pad is only there once a button has been pressed on it, so the nodes are made ahead and open or fail with ENODEV
  const ops = sessionOperations({ open: async minor => await openGamepadSession(minor - 1) })
  for (let index = 0; index < PadSlots; index++) drivers.push({ name: `js${index}`, major: 0, minor: index + 1, class: gamepad_class, ops })
  return drivers
}
