import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ioctl } from '@zenfs/core'

import { yuyvOf } from '@ecmaos-devices/camera'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const YUYV = 0x56595559, MJPG = 0x47504a4d
const IOC_READ = 2, IOC_WRITE = 1
// the numbers of linux/videodev2.h; the size is the 32-bit layout's (a WALI program's)
const request = (direction: number, number: number, size: number) => ((direction << 30) | (size << 16) | (0x56 << 8) | number) >>> 0
const QUERYCAP = request(IOC_READ, 0, 104)
const ENUM_FMT = request(IOC_READ | IOC_WRITE, 2, 64)
const G_FMT = request(IOC_READ | IOC_WRITE, 4, 204)
const S_FMT = request(IOC_READ | IOC_WRITE, 5, 204)
const TRY_FMT = request(IOC_READ | IOC_WRITE, 64, 204)
const REQBUFS = request(IOC_READ | IOC_WRITE, 8, 20)
const G_PARM = request(IOC_READ | IOC_WRITE, 21, 204)
const S_PARM = request(IOC_READ | IOC_WRITE, 22, 204)
const ENUMINPUT = request(IOC_READ | IOC_WRITE, 26, 80)
const G_INPUT = request(IOC_READ, 38, 4)
const S_INPUT = request(IOC_READ | IOC_WRITE, 39, 4)
const ENUM_FRAMESIZES = request(IOC_READ | IOC_WRITE, 74, 44)
const ENUM_FRAMEINTERVALS = request(IOC_READ | IOC_WRITE, 75, 52)
const QUERYCTRL = request(IOC_READ | IOC_WRITE, 36, 68)
const STREAMON = request(IOC_WRITE, 18, 4)

const words = (...values: number[]) => {
  const out = new Uint8Array(Math.max(4, values.length * 4))
  values.forEach((value, i) => new DataView(out.buffer).setUint32(i * 4, value >>> 0, true))
  return out
}
const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true)
const string = (bytes: Uint8Array, at: number, length: number) => new TextDecoder().decode(bytes.subarray(at, at + length)).replace(/\0.*$/s, '')

describe('a camera as /dev/video<n>', () => {
  let kernel: Kernel
  const asked: unknown[] = []
  const stopped: string[] = []
  const createElement = document.createElement.bind(document)

  beforeAll(async () => {
    // a camera that gives the size it is asked for (up to 1280 x 720) and a picture of solid red
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: {
        enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'a', label: 'Front Camera' }, { kind: 'audioinput', deviceId: 'm', label: 'Mic' }, { kind: 'videoinput', deviceId: 'b', label: 'Back Camera' }],
        getUserMedia: async (constraints: { video: { deviceId?: { exact: string }, width?: { ideal: number }, height?: { ideal: number } } }) => {
          asked.push(constraints.video)
          const width = Math.min(1280, constraints.video.width?.ideal ?? 640), height = Math.min(720, constraints.video.height?.ideal ?? 480)
          return {
            size: [width, height],
            getVideoTracks: () => [{ addEventListener() {}, getCapabilities: () => ({ width: { max: 1280 }, height: { max: 720 } }) }],
            getTracks: () => [{ stop: () => stopped.push('track') }]
          }
        }
      },
      configurable: true
    })
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'video') {
        const video = { muted: false, playsInline: false, srcObject: null as null | { size: number[] }, play: async () => {}, pause() {}, get videoWidth() { return video.srcObject?.size[0] ?? 0 }, get videoHeight() { return video.srcObject?.size[1] ?? 0 } }
        return video
      }
      if (tag === 'canvas') {
        const canvas = {
          width: 0, height: 0,
          getContext: () => ({
            drawImage() {},
            getImageData: (_x: number, _y: number, w: number, h: number) => {
              const data = new Uint8ClampedArray(w * h * 4)
              for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 3] = 255 }
              return { data }
            }
          }),
          toBlob: (done: (blob: unknown) => void) => done({ arrayBuffer: async () => Uint8Array.of(0xff, 0xd8, canvas.width >> 8, canvas.width & 0xff, 0xff, 0xd9).buffer })
        }
        return canvas
      }
      return createElement(tag)
    }) as never)
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  })

  afterAll(() => { vi.restoreAllMocks() })

  const call = async (path: string, number: number, arg?: Uint8Array) => await ioctl(path, number, arg) as Uint8Array

  it('has a node for each camera the browser lists, on the video4linux major, and the camera command on another', async () => {
    const fs = kernel.filesystem.fs
    const video0 = await fs.stat('/dev/video0'), video1 = await fs.stat('/dev/video1')
    expect(video0.isCharacterDevice()).toBe(true)
    const numbers = (rdev: number | bigint) => [Number(BigInt(rdev) >> 20n), Number(BigInt(rdev) & 0xfffffn)]
    expect(numbers(video0.rdev)).toEqual([81, 0])
    expect(numbers(video1.rdev)).toEqual([81, 1])
    expect(numbers((await fs.stat('/dev/camera')).rdev)[0]).not.toBe(81)
    await expect(fs.stat('/dev/video2')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('VIDIOC_QUERYCAP says it captures and reads', async () => {
    const cap = await call('/dev/video0', QUERYCAP)
    expect(string(cap, 0, 16)).toBe('ecmaos-camera')
    expect(string(cap, 16, 32)).toBe('Front Camera')
    expect(string(cap, 48, 32)).toBe('web:camera0')
    expect(u32(cap, 88)).toBe(0x01000001) // device_caps: V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_READWRITE
    expect(u32(cap, 84)).toBe(0x81000001) // capabilities: the same, with V4L2_CAP_DEVICE_CAPS
    expect(string(await call('/dev/video1', QUERYCAP), 16, 32)).toBe('Back Camera')
  })

  it('lists YUYV and Motion-JPEG, the sizes and the rates', async () => {
    const first = await call('/dev/video0', ENUM_FMT, words(0, 1))
    expect([u32(first, 44), string(first, 12, 32), u32(first, 8)]).toEqual([YUYV, 'YUYV 4:2:2', 0])
    const second = await call('/dev/video0', ENUM_FMT, words(1, 1))
    expect([u32(second, 44), string(second, 12, 32), u32(second, 8)]).toEqual([MJPG, 'Motion-JPEG', 1])
    await expect(call('/dev/video0', ENUM_FMT, words(2, 1))).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(call('/dev/video0', ENUM_FMT, words(0, 2))).rejects.toMatchObject({ code: 'EINVAL' })

    const sizes: number[][] = []
    for (let index = 0; ; index++) {
      try {
        const size = await call('/dev/video0', ENUM_FRAMESIZES, words(index, YUYV))
        expect(u32(size, 8)).toBe(1) // V4L2_FRMSIZE_TYPE_DISCRETE
        sizes.push([u32(size, 12), u32(size, 16)])
      } catch (error) { expect(error).toMatchObject({ code: 'EINVAL' }); break }
    }
    expect(sizes).toEqual([[1280, 720], [800, 600], [640, 480], [320, 240], [160, 120]])

    const rates: number[] = []
    for (let index = 0; index < 8; index++) {
      try {
        const rate = await call('/dev/video0', ENUM_FRAMEINTERVALS, words(index, YUYV, 640, 480))
        expect(u32(rate, 20)).toBe(1)
        rates.push(u32(rate, 24))
      } catch (error) { expect(error).toMatchObject({ code: 'EINVAL' }); break }
    }
    expect(rates).toEqual([30, 15, 10, 5, 1])
  })

  it('G_FMT gives YUYV at the camera\'s size; S_FMT asks the camera for another and TRY_FMT changes nothing', async () => {
    const format = (type: number, width: number, height: number, fourcc: number) => { const out = new Uint8Array(204); out.set(words(type, width, height, fourcc), 0); return out }
    const got = await call('/dev/video0', G_FMT, format(1, 0, 0, 0))
    expect([u32(got, 4), u32(got, 8), u32(got, 12), u32(got, 16)]).toEqual([640, 480, YUYV, 1])
    expect([u32(got, 20), u32(got, 24)]).toEqual([1280, 614400]) // bytesperline, sizeimage

    const tried = await call('/dev/video0', TRY_FMT, format(1, 321, 241, 0x12345678))
    expect([u32(tried, 4), u32(tried, 8), u32(tried, 12)]).toEqual([320, 240, YUYV]) // even sizes; an unknown format becomes YUYV
    expect(u32(await call('/dev/video0', G_FMT, format(1, 0, 0, 0)), 4)).toBe(640)

    await expect(call('/dev/video0', G_FMT, format(2, 0, 0, 0))).rejects.toMatchObject({ code: 'EINVAL' })

    const set = await call('/dev/video0', S_FMT, format(1, 1280, 720, MJPG))
    expect([u32(set, 4), u32(set, 8), u32(set, 12), u32(set, 20), u32(set, 24)]).toEqual([1280, 720, MJPG, 0, 1280 * 720 * 2])
    expect(asked.at(-1)).toMatchObject({ deviceId: { exact: 'a' }, width: { ideal: 1280 }, height: { ideal: 720 } })
    const again = await call('/dev/video0', G_FMT, format(1, 0, 0, 0))
    expect([u32(again, 4), u32(again, 12)]).toEqual([1280, MJPG])
  })

  it('G_PARM / S_PARM carry the frame rate; the one input is the camera; controls and buffers are refused', async () => {
    const parm = (num: number, den: number) => { const out = new Uint8Array(204); out.set(words(1, 0, 0, num, den), 0); return out }
    const got = await call('/dev/video0', G_PARM, parm(0, 0))
    expect([u32(got, 4), u32(got, 12), u32(got, 16)]).toEqual([0x1000, 1, 15])
    const set = await call('/dev/video0', S_PARM, parm(1, 10))
    expect([u32(set, 12), u32(set, 16)]).toEqual([1, 10])
    expect(u32(await call('/dev/video0', G_PARM, parm(0, 0)), 16)).toBe(10)

    const input = await call('/dev/video0', ENUMINPUT, new Uint8Array(80))
    expect([string(input, 4, 32), u32(input, 36)]).toEqual(['Front Camera', 2])
    await expect(call('/dev/video0', ENUMINPUT, words(1))).rejects.toMatchObject({ code: 'EINVAL' })
    expect(u32(await call('/dev/video0', G_INPUT), 0)).toBe(0)
    await call('/dev/video0', S_INPUT, words(0))
    await expect(call('/dev/video0', S_INPUT, words(1))).rejects.toMatchObject({ code: 'EINVAL' })

    await expect(call('/dev/video0', QUERYCTRL, new Uint8Array(68))).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(call('/dev/video0', REQBUFS, words(4, 1, 1))).rejects.toMatchObject({ code: 'EINVAL' }) // no buffers to map: a program reads
    await call('/dev/video0', REQBUFS, words(0, 1, 1))
    await expect(call('/dev/video0', STREAMON, words(1))).rejects.toMatchObject({ code: 'ENOTTY' })
  })

  it('a read gives one whole frame, of the size S_FMT set', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/video.js', `
      const { open, close, read, write, ioctl } = globalThis.ecmaosSyscalls
      const out = []
      const fd = open('/dev/video0', 2, 0)
      // a 16 x 16 picture in YUYV (the camera has been left as MJPG)
      const format = new Uint8Array(204)
      new DataView(format.buffer).setUint32(0, 1, true)
      new DataView(format.buffer).setUint32(4, 16, true)
      new DataView(format.buffer).setUint32(8, 16, true)
      new DataView(format.buffer).setUint32(12, 0x56595559, true)
      try { await ioctl(fd, ${S_FMT}, format) } catch (e) { out.push('error ' + e.code) }
      const buf = new Uint8Array(4096)
      const n = read(fd, buf, -1)
      out.push(n + ':' + Array.from(buf.subarray(0, 4)).join(','))
      const m = read(fd, buf.subarray(0, 5), -1)
      out.push(String(m))
      close(fd)
      const file = open('/tmp/video-result', 1 | 64 | 512, 0o644)
      write(file, new TextEncoder().encode(out.join('|')))
      close(file)
    `, { mode: 0o755 })
    expect(await kernel.shell.execute('/tmp/video.js')).toBe(0)
    // 16 x 16 pixels of YUYV is 512 bytes; red is Y 76, U 85, Y 76, V 255; a smaller buffer gets what fits and the rest is dropped
    expect(await kernel.filesystem.fs.readFile('/tmp/video-result', 'utf8')).toBe('512:76,85,76,255|5')
    expect([...yuyvOf(Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 255), 2, 1)]).toEqual([76, 85, 76, 255])
  })

  it('v4l2grab, a WALI program, lists the formats and sizes and takes a picture', async () => {
    const fs = kernel.filesystem.fs
    expect(await kernel.shell.execute('v4l2grab -i > /tmp/v4l2.out 2> /tmp/v4l2.err')).toBe(0)
    expect(await fs.readFile('/tmp/v4l2.err', 'utf8')).toBe('')
    const out = await fs.readFile('/tmp/v4l2.out', 'utf8')
    expect(out).toContain('/dev/video0: Front Camera (ecmaos-camera, web:camera0)\n  format YUYV  YUYV 4:2:2\n    1280x720\n')
    expect(out).toContain('  format MJPG  Motion-JPEG\n')
    expect(await kernel.shell.execute('v4l2grab -s 160x120 -r 30 -n 2 -o /tmp/shot.ppm 2> /tmp/v4l2.err')).toBe(0)
    expect(await fs.readFile('/tmp/v4l2.err', 'utf8')).toBe('v4l2grab: 160x120 YUYV\n')
    const ppm = await fs.readFile('/tmp/shot.ppm')
    expect(new TextDecoder().decode(ppm.subarray(0, 15))).toBe('P6\n160 120\n255\n')
    // the picture is red
    expect(ppm.length).toBe(15 + 160 * 120 * 3)
    expect([...ppm.subarray(15, 18)].map(value => value > 240 || value < 15)).toEqual([true, true, true])
    expect(ppm[15]).toBeGreaterThan(240)
    expect(await kernel.shell.execute('v4l2grab -f mjpg -s 320x240 -o /tmp/shot.jpg 2> /dev/null')).toBe(0)
    expect([...await fs.readFile('/tmp/shot.jpg')]).toEqual([0xff, 0xd8, 1, 0x40, 0xff, 0xd9])
  }, 60000)

  it('the camera is let go with the last close', async () => {
    await new Promise(resolve => setTimeout(resolve, 3200))
    expect(stopped).toContain('track')
  }, 10000)
})
