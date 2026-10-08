import { Class } from '@zenfs/linux'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

export { openCameraSession, frameOf } from './session.js'
export type { CameraEnvironment, CameraSessionOptions } from './session.js'

export const pkg = {
  name: 'camera',
  version: '0.1.0',
  description: 'Camera device driver',
  help: `
  Usage:
    camera list          List the cameras
    camera request       Ask the browser for camera access (needed once, before a camera can be offered with attach -s camera:N)
  `
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!media) {
    terminal.writeln('Error: this machine has no camera access')
    return 1
  }
  switch (args[0]) {
    case 'list': {
      const cameras = (await media.enumerateDevices()).filter(device => device.kind === 'videoinput')
      if (!cameras.length) terminal.writeln('No cameras found')
      cameras.forEach((camera, index) => terminal.writeln(`${index}: ${camera.label || '(unnamed until access is granted)'}`))
      return 0
    }
    case 'request': {
      try {
        const stream = await media.getUserMedia({ video: true })
        stream.getTracks().forEach(track => track.stop())
        terminal.writeln('Camera access granted')
        return 0
      } catch (error) {
        terminal.writeln(`Error: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }
    default:
      terminal.writeln(pkg.help)
      return 0
  }
}

/** `/sys/class/camera` */
const camera_class = new Class('camera')

// A camera is offered to another machine with `attach -s HOST NAME camera:N`; locally it is the command line, since a
// picture stream needs the page's video pipeline and has no use as a file on the machine that owns the camera.
export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  return [{
    name: 'camera',
    major: 81,
    minor: 0,
    class: camera_class,
    ops: { read: () => 0, write: () => {} }
  }]
}
