import { Feed, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'

/** What the camera needs from the page; the browser's by default, replaceable so the session can be tried without a camera */
export interface CameraEnvironment {
  enumerateDevices(): Promise<Array<{ kind: string, deviceId: string, label: string }>>
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  /** A video element that plays `stream`, resolved once it has a picture */
  play(stream: MediaStream): Promise<{ video: CanvasImageSource, width: number, height: number, maxWidth?: number, maxHeight?: number, stop(): void }>
  /** A JPEG of the current picture of `video` */
  jpeg(video: CanvasImageSource, width: number, height: number, quality: number): Promise<Uint8Array>
  /** The current picture of `video` as RGBA, four bytes a pixel */
  pixels(video: CanvasImageSource, width: number, height: number): Promise<Uint8Array>
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
      const capabilities = stream.getVideoTracks()[0]?.getCapabilities?.()
      return {
        video, width: video.videoWidth, height: video.videoHeight,
        maxWidth: capabilities?.width?.max, maxHeight: capabilities?.height?.max,
        stop() { video.pause(); video.srcObject = null }
      }
    },
    async pixels(video, width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(video, 0, 0, width, height)
      return new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)
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

/** How a picture is carried: the stream's (length, then JPEG), or bare, as a `/dev/video` node reads it */
export type CameraPayload = 'prefixed' | 'mjpg' | 'yuyv'

export interface CameraSessionOptions {
  /** Which camera, counting the browser's list from 0; default 0 */
  index?: number
  /** Pictures per second, 1 to 30; default 5 */
  fps?: number
  /** JPEG quality, 0.1 to 1; default 0.7 */
  quality?: number
  /** What each chunk is; default `prefixed`. `mjpg` is a bare JPEG and `yuyv` is the picture as packed YUV 4:2:2, width * height * 2 bytes. */
  payload?: CameraPayload
  /** The size to ask the camera for; it gives the nearest it has (see `info`) */
  width?: number
  height?: number
  environment?: CameraEnvironment
}

/** A picture as the stream carries it: the length of the JPEG (u32, little endian) and then the JPEG */
export function frameOf(jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + jpeg.length)
  new DataView(out.buffer).setUint32(0, jpeg.length, true)
  out.set(jpeg, 4)
  return out
}

/** RGBA pixels as packed YUV 4:2:2 (`YUYV`: Y0 U Y1 V for each pair of pixels), full range, as JPEG's colour space has it */
export function yuyvOf(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2)
  const clamp = (value: number) => value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
  for (let at = 0, to = 0; at + 7 < rgba.length && to + 3 < out.length; at += 8, to += 4) {
    const r0 = rgba[at]!, g0 = rgba[at + 1]!, b0 = rgba[at + 2]!
    const r1 = rgba[at + 4]!, g1 = rgba[at + 5]!, b1 = rgba[at + 6]!
    const r = (r0 + r1) / 2, g = (g0 + g1) / 2, b = (b0 + b1) / 2
    out[to] = clamp(0.299 * r0 + 0.587 * g0 + 0.114 * b0)
    out[to + 1] = clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)
    out[to + 2] = clamp(0.299 * r1 + 0.587 * g1 + 0.114 * b1)
    out[to + 3] = clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)
  }
  return out
}

/**
 * A camera as a device session: a stream of pictures, at most `fps` a second. By default each is a JPEG preceded by its length
 * (u32 little endian); a `payload` of `mjpg` or `yuyv` gives them bare, which is what a `/dev/video` node reads. Pictures not
 * read in time are dropped, the oldest first, so a slow reader sees the present and not the past. Read only. The user has to
 * allow camera access to the page.
 *
 * Controls: `info` (name, size, rate, quality, payload and the sizes the camera can give), `format` (`[payload, width,
 * height]`: change what the chunks are and, if the size differs, ask the camera for it; gives the new `info`), `rate`
 * (`[fps]`) and `list`.
 */
export async function openCameraSession(options: CameraSessionOptions = {}): Promise<DeviceSession> {
  const environment = options.environment ?? browser()
  let fps = Math.max(1, Math.min(30, Math.round(options.fps ?? 5)))
  const quality = Math.max(0.1, Math.min(1, options.quality ?? 0.7))
  const index = options.index ?? 0
  let payload: CameraPayload = options.payload ?? 'prefixed'
  const cameras = (await environment.enumerateDevices()).filter(device => device.kind === 'videoinput')
  const chosen = cameras[index]
  if (!chosen) throw new SessionError('ENODEV', `no camera ${index}`)

  const acquire = async (width?: number, height?: number) => {
    let stream: MediaStream
    try {
      stream = await environment.getUserMedia({
        video: {
          deviceId: chosen.deviceId ? { exact: chosen.deviceId } : undefined,
          ...(width && height && { width: { ideal: width }, height: { ideal: height } })
        }
      })
    } catch (error) {
      throw new SessionError('EACCES', error instanceof Error ? error.message : 'the camera was refused')
    }
    return { stream, picture: await environment.play(stream) }
  }

  let { stream, picture } = await acquire(options.width, options.height)
  // Only a couple of pictures are worth keeping: a stale one is worse than none
  const feed = new Feed(2)
  let busy = false
  let closed = false
  let generation = 0

  const frame = async () => {
    if (payload === 'yuyv') return yuyvOf(await environment.pixels(picture.video, picture.width, picture.height), picture.width, picture.height)
    const jpeg = await environment.jpeg(picture.video, picture.width, picture.height, quality)
    return payload === 'mjpg' ? jpeg : frameOf(jpeg)
  }
  const tick = () => {
    if (busy || closed) return
    busy = true
    const mine = generation
    frame()
      .then(chunk => { if (!closed && mine === generation) feed.push(chunk) })
      .catch(error => session.emit?.('error', { message: error instanceof Error ? error.message : 'capture failed' }))
      .finally(() => { busy = false })
  }
  let timer = setInterval(tick, Math.round(1000 / fps))
  const ended = () => { clearInterval(timer); feed.end(); session.emit?.('disconnect', null) }
  const watch = () => { for (const track of stream.getVideoTracks()) track.addEventListener('ended', ended) }
  watch()

  /** The sizes worth offering: the usual ones the camera can give, and the one it gave */
  const sizes = () => {
    const usual: Array<[number, number]> = [[160, 120], [320, 240], [640, 480], [800, 600], [1280, 720], [1920, 1080]]
    const maxWidth = picture.maxWidth ?? picture.width, maxHeight = picture.maxHeight ?? picture.height
    const list = usual.filter(([w, h]) => w <= maxWidth && h <= maxHeight)
    if (!list.some(([w, h]) => w === picture.width && h === picture.height)) list.push([picture.width, picture.height])
    return list.sort((a, b) => b[0] * b[1] - a[0] * a[1])
  }
  const describe = () => ({ name: chosen.label, width: picture.width, height: picture.height, fps, quality, payload, sizes: sizes().flat() })

  const session: DeviceSession = {
    info: { kind: 'camera', read: true, write: false, name: chosen.label, width: picture.width, height: picture.height, fps, format: payload === 'prefixed' ? 'jpeg-lp' : payload },
    read: () => feed.next(),
    async control(op, args) {
      if (op === 'info') return describe()
      if (op === 'list') return cameras.map(camera => camera.label)
      if (op === 'rate') {
        fps = Math.max(1, Math.min(30, Math.round(Number(args[0]) || fps)))
        clearInterval(timer)
        timer = setInterval(tick, Math.round(1000 / fps))
        return describe()
      }
      if (op === 'format') {
        const next = String(args[0])
        if (next !== 'prefixed' && next !== 'mjpg' && next !== 'yuyv') throw new SessionError('EINVAL', 'no such format')
        const width = Number(args[1]) || picture.width, height = Number(args[2]) || picture.height
        if (width !== picture.width || height !== picture.height) {
          // Wait out a picture being made from the old one, then swap
          generation++
          const fresh = await acquire(width, height)
          if (closed) { fresh.picture.stop(); for (const track of fresh.stream.getTracks()) track.stop(); throw new SessionError('ENODEV', 'the camera has closed') }
          picture.stop()
          for (const track of stream.getTracks()) track.stop()
          ;({ stream, picture } = fresh)
          watch()
        }
        generation++
        payload = next
        feed.clear()
        return describe()
      }
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
