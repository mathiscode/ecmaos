import { Feed, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'

/** What the camera needs from the page; the browser's by default, replaceable so the session can be tried without a camera */
export interface CameraEnvironment {
  enumerateDevices(): Promise<Array<{ kind: string, deviceId: string, label: string }>>
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  /** A video element that plays `stream`, resolved once it has a picture */
  play(stream: MediaStream): Promise<{ video: CanvasImageSource, width: number, height: number, stop(): void }>
  /** A JPEG of the current picture of `video` */
  jpeg(video: CanvasImageSource, width: number, height: number, quality: number): Promise<Uint8Array>
}

const browser = (): CameraEnvironment => {
  const devices = (globalThis as unknown as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices
  const need = () => {
    if (!devices) throw new SessionError('ENODEV', 'this machine has no camera access')
    return devices
  }
  return {
    enumerateDevices: async () => await need().enumerateDevices(),
    getUserMedia: async constraints => await need().getUserMedia(constraints),
    async play(stream) {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      await video.play()
      return { video, width: video.videoWidth, height: video.videoHeight, stop() { video.pause(); video.srcObject = null } }
    },
    async jpeg(video, width, height, quality) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d')!.drawImage(video, 0, 0, width, height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (!blob) throw new SessionError('EIO', 'could not encode the picture')
      return new Uint8Array(await blob.arrayBuffer())
    }
  }
}

export interface CameraSessionOptions {
  /** Which camera, counting the browser's list from 0; default 0 */
  index?: number
  /** Pictures per second, 1 to 30; default 5 */
  fps?: number
  /** JPEG quality, 0.1 to 1; default 0.7 */
  quality?: number
  environment?: CameraEnvironment
}

/** A picture as the stream carries it: the length of the JPEG (u32, little endian) and then the JPEG */
export function frameOf(jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + jpeg.length)
  new DataView(out.buffer).setUint32(0, jpeg.length, true)
  out.set(jpeg, 4)
  return out
}

/**
 * A camera as a device session: a stream of JPEG pictures, each preceded by its length (u32 little endian), at most `fps` a
 * second. Pictures not read in time are dropped, the oldest first, so a slow reader sees the present and not the past. Read
 * only. The user has to allow camera access to the page. Control `info` gives the size of the picture.
 */
export async function openCameraSession(options: CameraSessionOptions = {}): Promise<DeviceSession> {
  const environment = options.environment ?? browser()
  const fps = Math.max(1, Math.min(30, Math.round(options.fps ?? 5)))
  const quality = Math.max(0.1, Math.min(1, options.quality ?? 0.7))
  const index = options.index ?? 0
  const cameras = (await environment.enumerateDevices()).filter(device => device.kind === 'videoinput')
  const chosen = cameras[index]
  if (!chosen) throw new SessionError('ENODEV', `no camera ${index}`)
  let stream: MediaStream
  try {
    stream = await environment.getUserMedia({ video: { deviceId: chosen.deviceId ? { exact: chosen.deviceId } : undefined } })
  } catch (error) {
    throw new SessionError('EACCES', error instanceof Error ? error.message : 'the camera was refused')
  }
  const picture = await environment.play(stream)
  // Only a couple of pictures are worth keeping: a stale one is worse than none
  const feed = new Feed(2)
  let busy = false
  let closed = false
  const timer = setInterval(() => {
    if (busy || closed) return
    busy = true
    environment.jpeg(picture.video, picture.width, picture.height, quality)
      .then(jpeg => { if (!closed) feed.push(frameOf(jpeg)) })
      .catch(error => session.emit?.('error', { message: error instanceof Error ? error.message : 'capture failed' }))
      .finally(() => { busy = false })
  }, Math.round(1000 / fps))
  const ended = () => { clearInterval(timer); feed.end(); session.emit?.('disconnect', null) }
  for (const track of stream.getVideoTracks()) track.addEventListener('ended', ended)
  const session: DeviceSession = {
    info: { kind: 'camera', read: true, write: false, name: chosen.label, width: picture.width, height: picture.height, fps, format: 'jpeg-lp' },
    read: () => feed.next(),
    async control(op) {
      if (op === 'info') return { name: chosen.label, width: picture.width, height: picture.height, fps, quality }
      if (op === 'list') return cameras.map(camera => camera.label)
      throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
    },
    close() {
      closed = true
      clearInterval(timer)
      picture.stop()
      for (const track of stream.getTracks()) track.stop()
      feed.end()
    }
  }
  return session
}
