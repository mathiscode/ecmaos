import { Class } from '@zenfs/linux'
import { controlOperations, sessionOperations } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { openCameraSession } from './session.js'
import { v4l2Changes, v4l2Ioctl, v4l2Request } from './v4l2.js'

export { openCameraSession, frameOf, yuyvOf } from './session.js'
export type { CameraEnvironment, CameraPayload, CameraSessionOptions } from './session.js'
export { v4l2Changes, v4l2Ioctl, v4l2Request, V4L2_PIX_FMT_YUYV, V4L2_PIX_FMT_MJPEG } from './v4l2.js'

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

/** `/sys/class/video4linux` */
const video_class = new Class('video4linux')
/** `/sys/class/camera` */
const camera_class = new Class('camera')

/**
 * `/dev/video<n>` (major 81, as Linux's video4linux has it) for each camera the browser lists, in its order; `camera` is the
 * command and its control node, on a major of its own. A camera is also offered to another machine with
 * `attach -s HOST NAME camera:N`. Opening a node asks the browser for the camera, which the user has to allow, and the last
 * close lets it go. A node reads whole frames (`YUYV` by default, `MJPG` after `VIDIOC_S_FMT`), one to a read, and answers
 * the V4L2 ioctls for the read I/O method (see `v4l2.ts`).
 */
export async function getDrivers(): Promise<KernelCharDevice[]> {
  return [{ name: 'camera', major: 0, minor: 0, class: camera_class, ops: controlOperations }]
}

/** The `video<n>` nodes that exist, by index, with what takes each away */
const nodes = new Map<number, () => void>()
let watching: KernelContext | undefined
let ops: ReturnType<typeof sessionOperations> | undefined

/** Gives each camera the browser lists a node, and takes away the nodes of cameras that are gone */
async function syncCameras(ctx: KernelContext): Promise<void> {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!media?.enumerateDevices) return
  try {
    const cameras = (await media.enumerateDevices()).filter(device => device.kind === 'videoinput')
    ops ??= sessionOperations({
      open: async minor => await openCameraSession({ index: minor, payload: 'yuyv', fps: 15 }),
      packets: true,
      ioctl: { accepts: v4l2Request, run: (session, request, arg, minor) => v4l2Ioctl(session, request, arg, minor), flushes: v4l2Changes },
      onError: error => (watching ?? ctx).log.warn(`camera: ${error.message}`)
    })
    const sessions = ops
    cameras.forEach((camera, index) => {
      if (nodes.has(index)) return
      const remove = ctx.devices.add(pkg.name, { name: `video${index}`, major: 81, minor: index, class: video_class, ops: sessions })
      nodes.set(index, () => { remove(); sessions.hangup(index) })
      ctx.log.info(`uvcvideo: ${camera.label || 'camera'} as /dev/video${index}`)
    })
    for (const [index, remove] of [...nodes]) {
      if (index < cameras.length) continue
      remove()
      nodes.delete(index)
      ctx.log.info(`uvcvideo: /dev/video${index} disconnected`)
    }
  } catch (error) {
    ctx.log.warn(`camera: cannot list cameras: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Lists the cameras, and again whenever the browser says its devices changed (one plugged in, one unplugged, one allowed) */
export async function watch(ctx: KernelContext): Promise<void> {
  const first = !watching
  watching = ctx
  await syncCameras(ctx)
  if (first) globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', () => { if (watching) void syncCameras(watching) })
}
