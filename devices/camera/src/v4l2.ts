/**
 * The ioctls of a `/dev/video<n>` node (`linux/videodev2.h`), answered from a camera session opened with a bare payload. The
 * type is `'V'` and the number says which. A program is WebAssembly, so the structures are laid out for a 32-bit target (a
 * `v4l2_format` is 204 bytes and its union begins at 4); the size in a request is not looked at, only its number.
 *
 * Only the read I/O method is here: `read` gives one whole frame. Streaming with buffers (`REQBUFS`, `QBUF`, `DQBUF`) needs
 * memory the program and the device share, so `REQBUFS` answers `EINVAL` for any count and a program falls back to `read`.
 */

import { withErrno } from 'kerium'
import type { DeviceSession } from '@ecmaos-devices/session'

export const V4l2Type = 0x56 // 'V'

export const V4L2_PIX_FMT_YUYV = 0x56595559 // 'YUYV'
export const V4L2_PIX_FMT_MJPEG = 0x47504a4d // 'MJPG'

const V4L2_BUF_TYPE_VIDEO_CAPTURE = 1
const V4L2_CAP_VIDEO_CAPTURE = 0x00000001, V4L2_CAP_READWRITE = 0x01000000, V4L2_CAP_DEVICE_CAPS = 0x80000000
const V4L2_FIELD_NONE = 1
const V4L2_COLORSPACE_JPEG = 7, V4L2_XFER_FUNC_SRGB = 2, V4L2_YCBCR_ENC_601 = 1, V4L2_QUANTIZATION_FULL_RANGE = 1
const V4L2_FMT_FLAG_COMPRESSED = 1
const V4L2_FRMSIZE_TYPE_DISCRETE = 1, V4L2_FRMIVAL_TYPE_DISCRETE = 1
const V4L2_INPUT_TYPE_CAMERA = 2
const V4L2_CAP_TIMEPERFRAME = 0x1000

const QUERYCAP = 0, ENUM_FMT = 2, G_FMT = 4, S_FMT = 5, REQBUFS = 8, G_CTRL = 27, S_CTRL = 28, QUERYCTRL = 36, QUERYMENU = 37
const G_INPUT = 38, S_INPUT = 39, ENUMINPUT = 26, G_PARM = 21, S_PARM = 22, TRY_FMT = 64, CROPCAP = 58, QUERY_EXT_CTRL = 103
const ENUM_FRAMESIZES = 74, ENUM_FRAMEINTERVALS = 75

const FORMATS = [
  { fourcc: V4L2_PIX_FMT_YUYV, payload: 'yuyv', description: 'YUYV 4:2:2', flags: 0 },
  { fourcc: V4L2_PIX_FMT_MJPEG, payload: 'mjpg', description: 'Motion-JPEG', flags: V4L2_FMT_FLAG_COMPRESSED }
] as const
const RATES = [30, 15, 10, 5, 1]

/** `S_FMT` and `S_PARM` change the pictures to come, so those already waiting are not what the program asked for */
export const v4l2Changes = (request: number) => v4l2Request(request) && ((request & 0xff) === S_FMT || (request & 0xff) === S_PARM)

export const v4l2Request = (request: number) => ((request >>> 8) & 0xff) === V4l2Type

/** The bytes of an ioctl's argument; from a program's worker they are a view of another realm's, which `instanceof` does not know */
const argument = (arg: unknown, size: number) => {
  const out = new Uint8Array(size)
  if (ArrayBuffer.isView(arg)) out.set(new Uint8Array(arg.buffer, arg.byteOffset, Math.min(arg.byteLength, size)))
  return out
}

interface Picture { name: string, width: number, height: number, fps: number, payload: string, sizes: number[] }

const picture = async (session: DeviceSession) => await session.control!('info', []) as unknown as Picture
const formatOf = (fourcc: number) => FORMATS.find(format => format.fourcc === fourcc)
const pairs = (list: number[]) => Array.from({ length: list.length / 2 }, (_, i) => [list[2 * i]!, list[2 * i + 1]!] as const)

/** `bytesperline` and `sizeimage` for a format at a size; a compressed picture has no line, and no more than raw to hold */
const layout = (payload: string, width: number, height: number) => ({ bytesperline: payload === 'yuyv' ? width * 2 : 0, sizeimage: width * height * 2 })

/** Writes the `v4l2_pix_format` that begins at `at`: width, height, pixelformat, field, bytesperline, sizeimage, colorspace, priv, flags, ycbcr_enc, quantization, xfer_func */
function putPix(view: DataView, at: number, format: typeof FORMATS[number], width: number, height: number) {
  const { bytesperline, sizeimage } = layout(format.payload, width, height)
  view.setUint32(at, width, true)
  view.setUint32(at + 4, height, true)
  view.setUint32(at + 8, format.fourcc, true)
  view.setUint32(at + 12, V4L2_FIELD_NONE, true)
  view.setUint32(at + 16, bytesperline, true)
  view.setUint32(at + 20, sizeimage, true)
  view.setUint32(at + 24, V4L2_COLORSPACE_JPEG, true)
  view.setUint32(at + 28, 0, true)
  view.setUint32(at + 32, 0, true)
  view.setUint32(at + 36, V4L2_YCBCR_ENC_601, true)
  view.setUint32(at + 40, V4L2_QUANTIZATION_FULL_RANGE, true)
  view.setUint32(at + 44, V4L2_XFER_FUNC_SRGB, true)
}

const text = (view: Uint8Array, at: number, length: number, value: string) => {
  const bytes = new TextEncoder().encode(value).subarray(0, length - 1)
  view.fill(0, at, at + length)
  view.set(bytes, at)
}

/** Answers `request` for the camera behind `session`: the bytes of the structure the program handed over, filled in */
export async function v4l2Ioctl(session: DeviceSession, request: number, arg: unknown, minor = 0): Promise<Uint8Array | number> {
  const number = request & 0xff
  switch (number) {
    case QUERYCAP: {
      // struct v4l2_capability { u8 driver[16]; u8 card[32]; u8 bus_info[32]; u32 version, capabilities, device_caps; u32 reserved[3]; }
      const out = new Uint8Array(104)
      const view = new DataView(out.buffer)
      const caps = V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_READWRITE
      text(out, 0, 16, 'ecmaos-camera')
      text(out, 16, 32, (await picture(session)).name || 'Camera')
      text(out, 48, 32, `web:camera${minor}`)
      view.setUint32(80, 0x00060000, true)
      view.setUint32(84, (caps | V4L2_CAP_DEVICE_CAPS) >>> 0, true)
      view.setUint32(88, caps, true)
      return out
    }
    case ENUM_FMT: {
      // struct v4l2_fmtdesc { u32 index, type, flags; u8 description[32]; u32 pixelformat, mbus_code; u32 reserved[3]; }
      const out = argument(arg, 64)
      const view = new DataView(out.buffer)
      const format = FORMATS[view.getUint32(0, true)]
      if (view.getUint32(4, true) !== V4L2_BUF_TYPE_VIDEO_CAPTURE || !format) throw withErrno('EINVAL')
      view.setUint32(8, format.flags, true)
      text(out, 12, 32, format.description)
      view.setUint32(44, format.fourcc, true)
      return out
    }
    case G_FMT:
    case S_FMT:
    case TRY_FMT: {
      // struct v4l2_format { u32 type; union { struct v4l2_pix_format pix; ...; u8 raw_data[200]; } fmt; }
      const out = argument(arg, 204)
      const view = new DataView(out.buffer)
      if (view.getUint32(0, true) !== V4L2_BUF_TYPE_VIDEO_CAPTURE) throw withErrno('EINVAL')
      const current = await picture(session)
      if (number === G_FMT) {
        putPix(view, 4, formatOf(current.payload === 'mjpg' ? V4L2_PIX_FMT_MJPEG : V4L2_PIX_FMT_YUYV)!, current.width, current.height)
        return out
      }
      // an unknown format becomes the first, as a driver's does; a size is made even and kept to what a picture can be
      const wanted = formatOf(view.getUint32(12, true)) ?? FORMATS[0]
      const width = Math.min(4096, Math.max(16, (view.getUint32(4, true) || current.width) & ~1))
      const height = Math.min(4096, Math.max(16, (view.getUint32(8, true) || current.height) & ~1))
      if (number === TRY_FMT) { putPix(view, 4, wanted, width, height); return out }
      const set = await session.control!('format', [wanted.payload, width, height]) as unknown as Picture
      putPix(view, 4, wanted, set.width, set.height)
      return out
    }
    case G_PARM:
    case S_PARM: {
      // struct v4l2_streamparm { u32 type; union { struct v4l2_captureparm { u32 capability, capturemode; struct { u32 numerator, denominator } timeperframe; u32 extendedmode, readbuffers; u32 reserved[4]; } capture; ...; u8 raw_data[200]; } parm; }
      const out = argument(arg, 204)
      const view = new DataView(out.buffer)
      if (view.getUint32(0, true) !== V4L2_BUF_TYPE_VIDEO_CAPTURE) throw withErrno('EINVAL')
      let current = await picture(session)
      if (number === S_PARM) {
        const numerator = view.getUint32(12, true), denominator = view.getUint32(16, true)
        if (numerator && denominator) current = await session.control!('rate', [Math.round(denominator / numerator)]) as unknown as Picture
      }
      out.fill(0, 4)
      view.setUint32(4, V4L2_CAP_TIMEPERFRAME, true)
      view.setUint32(12, 1, true)
      view.setUint32(16, current.fps, true)
      view.setUint32(24, 2, true)
      return out
    }
    case ENUMINPUT: {
      // struct v4l2_input { u32 index; u8 name[32]; u32 type, audioset, tuner; u64 std; u32 status, capabilities; u32 reserved[3]; }
      const out = argument(arg, 80)
      const view = new DataView(out.buffer)
      if (view.getUint32(0, true) !== 0) throw withErrno('EINVAL')
      text(out, 4, 32, (await picture(session)).name || 'Camera')
      view.setUint32(36, V4L2_INPUT_TYPE_CAMERA, true)
      return out
    }
    case G_INPUT: return new Uint8Array(4)
    case S_INPUT: {
      if (new DataView(argument(arg, 4).buffer).getUint32(0, true) !== 0) throw withErrno('EINVAL')
      return argument(arg, 4)
    }
    case ENUM_FRAMESIZES: {
      // struct v4l2_frmsizeenum { u32 index, pixel_format, type; union { struct { u32 width, height } discrete; struct { ... } stepwise; }; u32 reserved[2]; }
      const out = argument(arg, 44)
      const view = new DataView(out.buffer)
      if (!formatOf(view.getUint32(4, true))) throw withErrno('EINVAL')
      const sizes = pairs((await picture(session)).sizes)
      const found = sizes[view.getUint32(0, true)]
      if (!found) throw withErrno('EINVAL')
      view.setUint32(8, V4L2_FRMSIZE_TYPE_DISCRETE, true)
      view.setUint32(12, found[0], true)
      view.setUint32(16, found[1], true)
      return out
    }
    case ENUM_FRAMEINTERVALS: {
      // struct v4l2_frmivalenum { u32 index, pixel_format, width, height, type; union { struct v4l2_fract discrete; struct { ... } stepwise; }; u32 reserved[2]; }
      const out = argument(arg, 52)
      const view = new DataView(out.buffer)
      const rate = RATES[view.getUint32(0, true)]
      if (!formatOf(view.getUint32(4, true)) || rate === undefined) throw withErrno('EINVAL')
      view.setUint32(16, V4L2_FRMIVAL_TYPE_DISCRETE, true)
      view.setUint32(20, 1, true)
      view.setUint32(24, rate, true)
      return out
    }
    // no buffers shared with the program: it reads
    case REQBUFS: {
      const count = new DataView(argument(arg, 20).buffer).getUint32(0, true)
      if (count === 0) return argument(arg, 20)
      throw withErrno('EINVAL')
    }
    // a camera in a browser has none of these to set
    case QUERYCTRL: case QUERYMENU: case G_CTRL: case S_CTRL: case QUERY_EXT_CTRL: case CROPCAP: throw withErrno('EINVAL')
    default: throw withErrno('ENOTTY')
  }
}
