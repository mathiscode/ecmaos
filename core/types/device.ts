/**
 * Device types and interfaces
 */

import type { Class, DevT, FileOperations, TTYDriver } from '@zenfs/linux'
import type { Kernel, KernelContext, Shell, Terminal } from './index.ts'

/**
 * One character device a `KernelDevice` package registers, in the shape `@zenfs/linux`'s `char_dev.register` and
 * `Device` expect. `major` claims all 256 minors for `ops`, so several devices under one major must dispatch on
 * `file.devt.minor` inside `ops`. `major: 0` allocates one dynamically.
 */
export interface KernelCharDevice {
  /** The name this device gets under `/dev` */
  name: string
  /** LANANA/Linux major to claim, or 0 to allocate one dynamically */
  major: number
  /** This device's minor, once `major` is resolved */
  minor: number
  /** What a file on this device's node actually does */
  ops: FileOperations
  /** `/sys/class/<name>` this device is linked under; devices sharing a class share `/sys/class/<name>` */
  class: Class
}

/**
 * Interface representing a kernel device.
 * This essentially "wraps" one or many `@zenfs/linux` character devices
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
   * Get the character devices this package registers under `/dev`.
   * @param ctx - The kernel context (id/log/events/i18n); a driver has no need for the whole Kernel
   * @returns Promise resolving to the devices to register
   */
  getDrivers(ctx: KernelContext): Promise<KernelCharDevice[]>

  /**
   * Terminal drivers this package registers: `@zenfs/linux` `TTYDriver`s, for devices that are terminals on Linux (serial
   * ports). The kernel registers each one's device numbers and tells it the first open and the last close of a line, as it does
   * for {@link getDrivers}' devices. The package adds and removes lines itself (`driver.line(n).register()`), as devices come
   * and go.
   */
  getTTYDrivers?(ctx: KernelContext): Promise<TTYDriver[]>

  /**
   * Called once the majors are registered. A package whose devices come and go lists them here and keeps them up to date
   * with `ctx.devices.add`, which a driver returned from {@link getDrivers} cannot, as it is fixed at boot.
   */
  watch?(ctx: KernelContext): void | Promise<void>
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

/** A device number, once `char_dev.register` has resolved a possibly-dynamic major */
export type KernelDevT = DevT
