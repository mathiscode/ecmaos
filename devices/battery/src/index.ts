declare global {
  interface BatteryManager {
    charging: boolean
    chargingTime: number
    dischargingTime: number
    level: number
    onchargingchange: (() => void) | null
    onchargingtimechange: (() => void) | null
    ondischargingtimechange: (() => void) | null
    onlevelchange: (() => void) | null
  }

  interface Navigator {
    getBattery: () => Promise<BatteryManager>
  }
}

import ansi from 'ansi-escape-sequences'
import { Class } from '@zenfs/linux'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

export const pkg = {
  name: 'battery',
  version: '0.1.0',
  description: 'Battery device driver'
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options

  const usage = `
Usage: /dev/battery <command>

Commands:
  status              Show full battery status
  charging            Show if battery is currently charging
  chargingTime        Show time until battery is fully charged
  dischargingTime     Show time until battery is empty
  level               Show current battery level percentage
  --help              Show this help message
`

  if (!('getBattery' in navigator)) {
    terminal.writeln('Battery API not available')
    return 1
  }

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  const battery = await navigator.getBattery()

  try {
    switch(args[0]) {
      case 'status':
        terminal.writeln(`${ansi.style.bold}🔋 Battery Status:${ansi.style.reset}
      🔌 Charging: ${battery.charging ? ansi.style.green + 'Yes' : ansi.style.red + 'No'}${ansi.style.reset}
      ⏱️ Charging Time: ${battery.chargingTime === Infinity ? ansi.style.gray + 'N/A' : ansi.style.cyan + battery.chargingTime}${ansi.style.reset}
      ⌛ Discharging Time: ${battery.dischargingTime === Infinity ? ansi.style.gray + 'N/A' : ansi.style.cyan + battery.dischargingTime}${ansi.style.reset}
      📊 Level: ${ansi.style[battery.level > 0.5 ? 'green' : battery.level > 0.2 ? 'yellow' : 'red']}${(battery.level * 100).toFixed(1)}%${ansi.style.reset}`)
        break
      case 'charging':
        terminal.writeln(`${battery.charging}`)
        break
      case 'chargingTime':
        terminal.writeln(`${battery.chargingTime}`)
        break
      case 'dischargingTime':
        terminal.writeln(`${battery.dischargingTime}`)
        break
      case 'level':
        terminal.writeln(`${battery.level * 100}%`)
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

/** `/sys/class/battery` */
const battery_class = new Class('battery')

export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  if (!('getBattery' in navigator)) return []

  const battery = await navigator.getBattery()

  return [{
    name: 'battery',
    major: 10,
    minor: 100,
    class: battery_class,
    ops: {
      // level as a percentage (0-100), charging as 0/1, then chargingTime and dischargingTime in
      // seconds as float64s -- Infinity (unknown) round-trips correctly, unlike a single byte each
      read: (_file, buffer, start, end) => {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        view.setUint8(0, Math.round(battery.level * 100))
        view.setUint8(1, Number(battery.charging))
        view.setFloat64(2, battery.chargingTime, true)
        view.setFloat64(10, battery.dischargingTime, true)
        return Math.min(18, end - start)
      },
      write: () => {}
    }
  }]
}
