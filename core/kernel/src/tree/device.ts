/**
 * A device is a component that provides functionality to the system by interacting with hardware or emulating it,
 * through a standard interface.
 */

// --- Default Devices ---
import * as AudioDevice from '@ecmaos-devices/audio'
import * as BatteryDevice from '@ecmaos-devices/battery'
import * as BluetoothDevice from '@ecmaos-devices/bluetooth'
import * as CameraDevice from '@ecmaos-devices/camera'
import * as GamepadDevice from '@ecmaos-devices/gamepad'
import * as GeoDevice from '@ecmaos-devices/geo'
import * as GPUDevice from '@ecmaos-devices/gpu'
import * as HIDDevice from '@ecmaos-devices/hid'
import * as MIDIDevice from '@ecmaos-devices/midi'
import * as PresentationDevice from '@ecmaos-devices/presentation'
import * as SensorsDevice from '@ecmaos-devices/sensors'
import * as SerialDevice from '@ecmaos-devices/serial'
import * as TTYDevice from '@ecmaos-devices/tty'
import * as USBDevice from '@ecmaos-devices/usb'
import * as WebGLDevice from '@ecmaos-devices/webgl'

import type { KernelDevice } from '@ecmaos/types'

import { EvdevDevice } from '#lib/evdev.ts'

export const DefaultDevices: Record<string, KernelDevice> = {
  audio: AudioDevice,
  battery: BatteryDevice,
  bluetooth: BluetoothDevice,
  camera: CameraDevice,
  gamepad: GamepadDevice,
  geo: GeoDevice,
  gpu: GPUDevice,
  hid: HIDDevice,
  input: EvdevDevice,
  midi: MIDIDevice,
  presentation: PresentationDevice,
  sensors: SensorsDevice,
  serial: SerialDevice,
  tty: TTYDevice,
  usb: USBDevice,
  webgl: WebGLDevice
}
