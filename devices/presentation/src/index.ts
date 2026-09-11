/**
 * I'm second-guessing the choice to make this a device rather than a command, but it's fine for now.
 */

import type { DeviceDriver } from '@zenfs/core'
import type { Kernel, KernelContext, KernelDeviceCLIOptions, KernelDeviceData } from '@ecmaos/types'

declare global {
  interface Navigator {
    readonly presentation: Presentation
  }

  interface Presentation {
    defaultRequest: PresentationRequest | null
  }

  interface PresentationRequest {
    start(): Promise<PresentationConnection>
    availability: boolean
    getAvailability(): Promise<boolean>
  }

  interface PresentationConnection {
    close(): void
    terminate(): void
  }
}

export const pkg = {
  name: 'presentation',
  version: '0.1.0',
  description: 'Web Presentation API device driver'
}

// @ts-ignore
let activeRequest: PresentationRequest | null = null
let activeConnection: PresentationConnection | null = null

export async function cli(options: KernelDeviceCLIOptions) {
  const usage = `
Usage: /dev/presentation <command>

Commands:
  list [url]            List available presentation displays (optional URL)
  start [url]           Start presenting the specified URL
  --help                Show this help message
`

  if (!options.args.length || options.args[0] === '--help') {
    options.terminal.writeln(usage)
    return 0
  }

  switch (options.args[0]) {
    case 'list':
      await listDisplays(options.kernel, options.args[1] || globalThis.location.href)
      break
    case 'start':
      await startPresentation(options.kernel, options.args[1] || globalThis.location.href)
      break
    default:
      options.terminal.writeln(`Unknown command: ${options.args[0]}`)
      options.terminal.writeln(usage)
      return 1
  }

  return 0
}

export async function getDrivers(_ctx: KernelContext): Promise<DeviceDriver<KernelDeviceData>[]> {
  const drivers: DeviceDriver<KernelDeviceData>[] = []

  if ('presentation' in navigator) {
    drivers.push({
      name: 'presentation',
      init: () => ({
        major: 10,
        minor: 156
      }),
      read: () => 0,
      write: () => 0
    })
  }

  return drivers
}

async function listDisplays(kernel: Kernel, presentationUrl: string) {
  if (!('PresentationRequest' in globalThis)) throw new Error('PresentationRequest API not supported')

  try {
    const url = new URL(presentationUrl)
    const request = new (globalThis as any).PresentationRequest([url.toString()])
    
    const availability = await request.getAvailability()
    kernel.terminal.writeln(`Available displays: ${availability ? 'Yes' : 'No'}`)
    
    if (availability) {
      const connectionState = activeConnection ? 'Connected' : 'Not connected'
      kernel.terminal.writeln(`Connection state: ${connectionState}`)
    }
  } catch (error) {
    kernel.terminal.writeln(`Error checking displays: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

async function startPresentation(kernel: Kernel, presentationUrl: string) {
  if (!('PresentationRequest' in globalThis)) throw new Error('PresentationRequest API not supported')

  try {
    // Close existing connection if any
    if (activeConnection) {
      activeConnection.close()
      activeConnection = null
    }

    const url = new URL(presentationUrl)
    const request = new (globalThis as any).PresentationRequest([url.toString()])
    activeRequest = request
    
    const available = await request.getAvailability()
    if (!available) throw new Error('No presentation displays available')
    
    const connection = await request.start()
    activeConnection = connection
    kernel.terminal.writeln(`Presentation started: ${url}`)
    
    connection.addEventListener('close', () => {
      activeConnection = null
      kernel.terminal.writeln('Presentation closed')
    })
    
    connection.addEventListener('terminate', () => {
      activeConnection = null
      kernel.terminal.writeln('Presentation terminated')
    })
  } catch (error) {
    activeRequest = null
    activeConnection = null
    kernel.terminal.writeln(`Error starting presentation: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}
