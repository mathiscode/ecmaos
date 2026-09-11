import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: uname [OPTION]...
Print system information.

  -a, --all                print all information
  -s, --kernel-name        print the kernel name
  -n, --nodename           print the network node hostname
  -r, --kernel-release     print the kernel release
  -v, --kernel-version     print the kernel version
  -m, --machine            print the machine hardware name
  -p, --processor          print the processor type
  -i, --hardware-platform  print the hardware platform
  -o, --operating-system   print the operating system
  --help                   display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'uname',
    description: 'Print system information',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {
      const process = ctx.process

      if (!process) return 1

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      let showAll = false
      let showKernelName = false
      let showNodename = false
      let showKernelRelease = false
      let showKernelVersion = false
      let showMachine = false
      let showProcessor = false
      let showHardwarePlatform = false
      let showOperatingSystem = false

      for (const arg of ctx.argv) {
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-a' || arg === '--all') {
          showAll = true
        } else if (arg === '-s' || arg === '--kernel-name') {
          showKernelName = true
        } else if (arg === '-n' || arg === '--nodename') {
          showNodename = true
        } else if (arg === '-r' || arg === '--kernel-release') {
          showKernelRelease = true
        } else if (arg === '-v' || arg === '--kernel-version') {
          showKernelVersion = true
        } else if (arg === '-m' || arg === '--machine') {
          showMachine = true
        } else if (arg === '-p' || arg === '--processor') {
          showProcessor = true
        } else if (arg === '-i' || arg === '--hardware-platform') {
          showHardwarePlatform = true
        } else if (arg === '-o' || arg === '--operating-system') {
          showOperatingSystem = true
        } else if (arg.startsWith('-')) {
          const flags = arg.slice(1).split('')
          if (flags.includes('a')) showAll = true
          if (flags.includes('s')) showKernelName = true
          if (flags.includes('n')) showNodename = true
          if (flags.includes('r')) showKernelRelease = true
          if (flags.includes('v')) showKernelVersion = true
          if (flags.includes('m')) showMachine = true
          if (flags.includes('p')) showProcessor = true
          if (flags.includes('i')) showHardwarePlatform = true
          if (flags.includes('o')) showOperatingSystem = true
          const invalidFlags = flags.filter(f => !['a', 's', 'n', 'r', 'v', 'm', 'p', 'i', 'o'].includes(f))
          if (invalidFlags.length > 0) {
            await io.writelnErr(`uname: invalid option -- '${invalidFlags[0]}'`)
            await io.writelnErr("Try 'uname --help' for more information.")
            return 1
          }
        }
      }

      const highEntropyValues = await navigator.userAgentData?.getHighEntropyValues([
        "architecture",
        "bitness",
        "formFactor",
        "fullVersionList",
        "model",
        "platformVersion",
        "wow64"
      ]) ?? {}

      const kernelName = kernel.name
      const kernelVersion = kernel.version
      const nodename = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const machine = navigator.userAgentData?.platform || navigator.platform || 'unknown'
      const processor = highEntropyValues.architecture || 'unknown'
      const hardwarePlatform = highEntropyValues.model || 'unknown'
      const operatingSystem = kernelName

      if (showAll || (!showKernelName && !showNodename && !showKernelRelease && !showKernelVersion && !showMachine && !showProcessor && !showHardwarePlatform && !showOperatingSystem)) {
        const output = `${kernelName} ${nodename} ${kernelVersion} ${machine} ${processor} ${hardwarePlatform} ${operatingSystem}`
        await io.writeln(output)
      } else {
        const parts: string[] = []
        if (showAll || showKernelName) parts.push(kernelName)
        if (showAll || showNodename) parts.push(nodename)
        if (showAll || showKernelRelease) parts.push(kernelVersion)
        if (showAll || showKernelVersion) parts.push(kernelVersion)
        if (showAll || showMachine) parts.push(machine)
        if (showAll || showProcessor) parts.push(processor)
        if (showAll || showHardwarePlatform) parts.push(hardwarePlatform)
        if (showAll || showOperatingSystem) parts.push(operatingSystem)
        await io.writeln(parts.join(' '))
      }

      return 0
    }
  })
}
