/**
 * Real `execve`'d `uname` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/uname.ts`) per `feat/1.0.0-execve-commands`. `kernel.name`/
 * `kernel.version` (build-time constants, no live kernel reference otherwise needed) come through
 * `env.KERNEL_NAME`/`env.KERNEL_VERSION`, threaded through `Shell`'s env at construction (see
 * `kernel.ts`), the same way `env.HOSTNAME` now carries what `hostname.mjs` needs. `navigator` is a
 * standard Worker global (unlike `window`, which never existed here even before migration), so
 * `navigator.userAgentData`/`navigator.platform` still work directly.
 */

const { argv, exit, write, env } = globalThis.ecmaosSyscalls

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

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
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

  for (const arg of args) {
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      write(2, new TextEncoder().encode(usage + '\n'))
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
      const invalid = flags.find(f => !['a', 's', 'n', 'r', 'v', 'm', 'p', 'i', 'o'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`uname: invalid option -- '${invalid}'\nTry 'uname --help' for more information.\n`))
        return 1
      }
    }
  }

  const highEntropyValues = (await navigator.userAgentData?.getHighEntropyValues?.([
    'architecture', 'bitness', 'formFactor', 'fullVersionList', 'model', 'platformVersion', 'wow64'
  ])) ?? {}

  const kernelName = env.KERNEL_NAME || 'ecmaOS'
  const kernelVersion = env.KERNEL_VERSION || '?.?.?'
  const nodename = env.HOSTNAME || 'localhost'
  const machine = navigator.userAgentData?.platform || navigator.platform || 'unknown'
  const processor = highEntropyValues.architecture || 'unknown'
  const hardwarePlatform = highEntropyValues.model || 'unknown'
  const operatingSystem = kernelName

  if (showAll || (!showKernelName && !showNodename && !showKernelRelease && !showKernelVersion && !showMachine && !showProcessor && !showHardwarePlatform && !showOperatingSystem)) {
    write(1, new TextEncoder().encode(`${kernelName} ${nodename} ${kernelVersion} ${machine} ${processor} ${hardwarePlatform} ${operatingSystem}\n`))
  } else {
    const parts = []
    if (showAll || showKernelName) parts.push(kernelName)
    if (showAll || showNodename) parts.push(nodename)
    if (showAll || showKernelRelease) parts.push(kernelVersion)
    if (showAll || showKernelVersion) parts.push(kernelVersion)
    if (showAll || showMachine) parts.push(machine)
    if (showAll || showProcessor) parts.push(processor)
    if (showAll || showHardwarePlatform) parts.push(hardwarePlatform)
    if (showAll || showOperatingSystem) parts.push(operatingSystem)
    write(1, new TextEncoder().encode(parts.join(' ') + '\n'))
  }

  return 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`uname: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
