/**
 * Device types and interfaces
 */

import type { DeviceDriver } from '@zenfs/core'
import type { Kernel, KernelContext, Shell, Terminal } from './index.ts'
/**
 * Interface representing a kernel device.
 * This essentially "wraps" one or many zenfs devices
 * and provides metadata and a CLI interface for it.
 */
export interface KernelDevice {
  /** 
   * Package metadata for the device
   */
  pkg: {
    /** Name of the device */
    name: string
    /** Version of the device */
    version: string
    /** Optional description of the device */
    description?: string
    /** Optional author of the device */
    author?: string
    /** Optional homepage URL for the device */
    homepage?: string
  }

  /**
   * Optional CLI handler for the device
   * @param options - CLI options passed to the device
   * @returns Promise resolving to exit code
   */
  cli?(options: KernelDeviceCLIOptions): Promise<number>

  /**
   * Get device drivers supported by this device
   * This allows the device to declare one or many individual devices in /dev
   * @param ctx - The kernel context (id/log/events/i18n); a driver has no need for the whole Kernel
   * @returns Promise resolving to array of device drivers
   */
  getDrivers(ctx: KernelContext): Promise<DeviceDriver[]>
}

/**
 * Options passed to device CLI handlers
 */
export interface KernelDeviceCLIOptions {
  /** Process ID of the CLI instance */
  pid: number
  /** Command line arguments */
  args: string[]
  /** Kernel instance */
  kernel: Kernel
  /** Shell instance */
  shell: Shell
  /** Terminal instance */
  terminal: Terminal
}
/**
 * Interface for storing device-specific data
 */
export interface KernelDeviceData {
  /** Key-value store for device data */
  [key: string]: unknown
}

