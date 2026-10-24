/**
 * `struct snd_pcm_hw_params` (`sound/asound.h`) and the rules that narrow it. A program (alsa-lib, through `SNDRV_PCM_IOCTL_HW_REFINE`
 * and `HW_PARAMS`) asks what the device can do by sending the ranges it would accept; the device gives them back cut down to what
 * it can, or refuses with `EINVAL` when nothing is left. `HW_PARAMS` also picks one value for each, which is the stream.
 *
 * Laid out for a WALI program: the structure is 608 bytes, the three masks (access, format, subformat) of 32 bytes begin at 4,
 * the twelve intervals (12 bytes each: min, max, and the bits open-min, open-max, integer, empty) at 260, then `rmask`, `cmask`,
 * `info`, `msbits`, `rate_num`, `rate_den` and the 8 byte `fifo_size` at 512.
 */

export const HwParamsSize = 608

export const ACCESS = 0, FORMAT = 1, SUBFORMAT = 2
export const SAMPLE_BITS = 8, FRAME_BITS = 9, CHANNELS = 10, RATE = 11, PERIOD_TIME = 12, PERIOD_SIZE = 13, PERIOD_BYTES = 14
export const PERIODS = 15, BUFFER_TIME = 16, BUFFER_SIZE = 17, BUFFER_BYTES = 18, TICK_TIME = 19
const FIRST_INTERVAL = SAMPLE_BITS
const INTERVALS = 12

export const ACCESS_RW_INTERLEAVED = 3
export const FORMAT_S8 = 0, FORMAT_U8 = 1, FORMAT_S16_LE = 2, FORMAT_S32_LE = 10, FORMAT_FLOAT_LE = 14, FORMAT_S24_3LE = 32

/** The sample formats the device takes, with the bytes one sample takes */
export const Formats: ReadonlyArray<{ format: number, bytes: number }> = [
  { format: FORMAT_S8, bytes: 1 },
  { format: FORMAT_U8, bytes: 1 },
  { format: FORMAT_S16_LE, bytes: 2 },
  { format: FORMAT_S24_3LE, bytes: 3 },
  { format: FORMAT_S32_LE, bytes: 4 },
  { format: FORMAT_FLOAT_LE, bytes: 4 }
]

export const bytesOf = (format: number) => Formats.find(entry => entry.format === format)?.bytes

/** SNDRV_PCM_INFO_INTERLEAVED, BLOCK_TRANSFER, PAUSE and PERFECT_DRAIN: a device that moves samples with read and write, can be paused, and needs no silence after the end */
export const InfoFlags = 0x100 | 0x10000 | 0x80000 | 0x40

export interface Interval { min: number, max: number, integer: boolean, empty: boolean }

export interface HwParams {
  flags: number
  masks: [Set<number>, Set<number>, Set<number>]
  intervals: Interval[]
  rmask: number
  cmask: number
  info: number
  msbits: number
  rateNum: number
  rateDen: number
}

const interval = (min: number, max: number, integer = true): Interval => ({ min, max, integer, empty: min > max })

export function parseHwParams(bytes: Uint8Array): HwParams {
  const view = new DataView(bytes.buffer, bytes.byteOffset, Math.max(bytes.byteLength, HwParamsSize))
  const masks = [0, 1, 2].map(index => {
    const set = new Set<number>()
    for (let bit = 0; bit < 256; bit++) if (view.getUint32(4 + index * 32 + (bit >> 5) * 4, true) & (1 << (bit & 31))) set.add(bit)
    return set
  }) as HwParams['masks']
  const intervals = Array.from({ length: INTERVALS }, (_, index) => {
    const at = 260 + index * 12
    const bits = view.getUint32(at + 8, true)
    return { min: view.getUint32(at, true), max: view.getUint32(at + 4, true), integer: !!(bits & 4), empty: !!(bits & 8) }
  })
  return {
    flags: view.getUint32(0, true), masks, intervals,
    rmask: view.getUint32(512, true), cmask: view.getUint32(516, true), info: view.getUint32(520, true),
    msbits: view.getUint32(524, true), rateNum: view.getUint32(528, true), rateDen: view.getUint32(532, true)
  }
}

/** The bytes of `params`, written over `into` (the program's structure, whose reserved space is left alone) */
export function writeHwParams(params: HwParams, into: Uint8Array): Uint8Array {
  const out = into.length >= HwParamsSize ? into : (() => { const grown = new Uint8Array(HwParamsSize); grown.set(into); return grown })()
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, params.flags, true)
  params.masks.forEach((set, index) => {
    for (let word = 0; word < 8; word++) view.setUint32(4 + index * 32 + word * 4, 0, true)
    for (const bit of set) {
      const at = 4 + index * 32 + (bit >> 5) * 4
      view.setUint32(at, view.getUint32(at, true) | (1 << (bit & 31)), true)
    }
  })
  params.intervals.forEach((value, index) => {
    const at = 260 + index * 12
    view.setUint32(at, value.min >>> 0, true)
    view.setUint32(at + 4, value.max >>> 0, true)
    view.setUint32(at + 8, (value.integer ? 4 : 0) | (value.empty ? 8 : 0), true)
  })
  view.setUint32(512, 0, true)
  view.setUint32(516, params.cmask, true)
  view.setUint32(520, params.info, true)
  view.setUint32(524, params.msbits, true)
  view.setUint32(528, params.rateNum, true)
  view.setUint32(532, params.rateDen, true)
  view.setUint32(536, 0, true)
  view.setUint32(540, 0, true)
  return out
}

/** What the device can do, before a program narrows it */
export const Limits = {
  channels: [1, 8],
  rate: [8000, 192000],
  periodSize: [16, 1 << 16],
  periods: [2, 1024],
  bufferSize: [32, 1 << 19]
} as const

export function anyParams(): HwParams {
  const intervals: Interval[] = Array.from({ length: INTERVALS }, () => interval(0, 0xffffffff))
  const set = (param: number, min: number, max: number, integer = true) => { intervals[param - FIRST_INTERVAL] = interval(min, max, integer) }
  set(SAMPLE_BITS, 8, 32)
  set(FRAME_BITS, 8, 32 * Limits.channels[1])
  set(CHANNELS, ...Limits.channels)
  set(RATE, ...Limits.rate)
  set(PERIOD_TIME, 0, 0xffffffff, false)
  set(PERIOD_SIZE, ...Limits.periodSize)
  set(PERIOD_BYTES, 0, 0xffffffff)
  set(PERIODS, ...Limits.periods)
  set(BUFFER_TIME, 0, 0xffffffff, false)
  set(BUFFER_SIZE, ...Limits.bufferSize)
  set(BUFFER_BYTES, 0, 0xffffffff)
  set(TICK_TIME, 0, 1_000_000, false)
  return {
    flags: 0,
    masks: [new Set([ACCESS_RW_INTERLEAVED]), new Set(Formats.map(entry => entry.format)), new Set([0])],
    intervals, rmask: 0xffffffff, cmask: 0, info: 0, msbits: 0, rateNum: 0, rateDen: 0
  }
}

const at = (params: HwParams, param: number) => params.intervals[param - FIRST_INTERVAL]!

const MICROSECONDS = 1_000_000

/** Narrows `target` to `[min, max]`; true when that changed it */
function narrow(target: Interval, min: number, max: number): boolean {
  let changed = false
  if (Number.isNaN(min) || Number.isNaN(max)) return false
  min = Math.max(0, min)
  if (min > target.min) { target.min = min; changed = true }
  if (max < target.max) { target.max = max; changed = true }
  if (target.min > target.max && !target.empty) { target.empty = true; changed = true }
  return changed
}

const cdiv = (a: number, b: number) => a === 0 ? 0 : b === 0 ? Infinity : Math.ceil(a / b)
const fdiv = (a: number, b: number) => b === 0 ? Infinity : Math.floor(a / b)

/** `product = left * right` (an interval for each): narrows all three */
function product(product: Interval, left: Interval, right: Interval): boolean {
  let changed = narrow(product, left.min * right.min, left.max * right.max)
  changed = narrow(left, cdiv(product.min, right.max), fdiv(product.max, right.min)) || changed
  changed = narrow(right, cdiv(product.min, left.max), fdiv(product.max, left.min)) || changed
  return changed
}

/** `bytes = size * bits / 8` */
function bytesOfSize(bytes: Interval, size: Interval, bits: Interval): boolean {
  let changed = narrow(bytes, Math.floor(size.min * bits.min / 8), Math.ceil(size.max * bits.max / 8))
  changed = narrow(size, cdiv(bytes.min * 8, bits.max), fdiv(bytes.max * 8, bits.min)) || changed
  changed = narrow(bits, cdiv(bytes.min * 8, size.max), fdiv(bytes.max * 8, size.min)) || changed
  return changed
}

/**
 * `time = size * 1e6 / rate`, the times a whole number of microseconds. A time is rounded when it is made, so one that is read
 * back stands for any real time within a microsecond of it; the rule allows that much, and makes the time from a size
 * rounded outwards so the real one is always inside.
 */
function timeOfSize(time: Interval, size: Interval, rate: Interval): boolean {
  let changed = narrow(time, Math.floor(size.min * MICROSECONDS / rate.max), Math.ceil(size.max * MICROSECONDS / rate.min))
  const early = Math.max(0, time.min - 1), late = time.max + 1
  changed = narrow(size, cdiv(early * rate.min, MICROSECONDS), fdiv(late * rate.max, MICROSECONDS)) || changed
  changed = narrow(rate, cdiv(size.min * MICROSECONDS, late), early === 0 ? Infinity : fdiv(size.max * MICROSECONDS, early)) || changed
  return changed
}

/** Keeps the formats whose sample fits `bits`, and the bits the formats allow */
function formatBits(params: HwParams): boolean {
  const bits = at(params, SAMPLE_BITS)
  const formats = params.masks[FORMAT]
  let changed = false
  for (const format of [...formats]) {
    const width = (bytesOf(format) ?? 0) * 8
    if (width < bits.min || width > bits.max) { formats.delete(format); changed = true }
  }
  if (!formats.size) {
    if (!bits.empty) { bits.empty = true; changed = true }
    return changed
  }
  const widths = [...formats].map(format => bytesOf(format)! * 8)
  return narrow(bits, Math.min(...widths), Math.max(...widths)) || changed
}

/** Runs every rule until none changes anything; false when a parameter is left with no value */
function settle(params: HwParams): boolean {
  for (let round = 0; round < 64; round++) {
    let changed = false
    for (const [index, set] of params.masks.entries()) {
      const allowed = index === ACCESS ? [ACCESS_RW_INTERLEAVED] : index === FORMAT ? Formats.map(entry => entry.format) : [0]
      for (const value of [...set]) if (!allowed.includes(value)) { set.delete(value); changed = true }
    }
    const channels = at(params, CHANNELS), rate = at(params, RATE)
    changed = narrow(channels, ...Limits.channels) || changed
    changed = narrow(rate, ...Limits.rate) || changed
    changed = narrow(at(params, PERIOD_SIZE), ...Limits.periodSize) || changed
    changed = narrow(at(params, PERIODS), ...Limits.periods) || changed
    changed = narrow(at(params, BUFFER_SIZE), ...Limits.bufferSize) || changed
    changed = formatBits(params) || changed
    changed = product(at(params, FRAME_BITS), at(params, SAMPLE_BITS), channels) || changed
    changed = bytesOfSize(at(params, PERIOD_BYTES), at(params, PERIOD_SIZE), at(params, FRAME_BITS)) || changed
    changed = bytesOfSize(at(params, BUFFER_BYTES), at(params, BUFFER_SIZE), at(params, FRAME_BITS)) || changed
    changed = product(at(params, BUFFER_SIZE), at(params, PERIOD_SIZE), at(params, PERIODS)) || changed
    changed = timeOfSize(at(params, PERIOD_TIME), at(params, PERIOD_SIZE), rate) || changed
    changed = timeOfSize(at(params, BUFFER_TIME), at(params, BUFFER_SIZE), rate) || changed
    if (params.intervals.some(value => value.empty) || params.masks.some(set => !set.size)) return false
    if (!changed) return true
  }
  return true
}

/**
 * `SNDRV_PCM_IOCTL_HW_REFINE`: the request narrowed to what the device can do. `cmask` has a bit for each parameter that changed.
 * Returns undefined (`EINVAL`) when nothing is left.
 */
export function refine(request: HwParams): HwParams | undefined {
  const params: HwParams = {
    ...request,
    masks: request.masks.map(set => new Set(set)) as HwParams['masks'],
    intervals: request.intervals.map(value => ({ ...value }))
  }
  // an interval a program sent as "not set" (min and max both 0 with the empty bit clear) is the whole range
  const before = { masks: request.masks.map(set => new Set(set)), intervals: request.intervals.map(value => ({ ...value })) }
  if (!settle(params)) return undefined
  let cmask = 0
  for (let index = 0; index < 3; index++) if (params.masks[index]!.size !== before.masks[index]!.size) cmask |= 1 << index
  for (let index = 0; index < INTERVALS; index++) {
    const now = params.intervals[index]!, was = before.intervals[index]!
    if (now.min !== was.min || now.max !== was.max) cmask |= 1 << (index + FIRST_INTERVAL)
    // the flags a program may have left clear
    now.integer = now.integer || was.integer
  }
  for (const param of [SAMPLE_BITS, FRAME_BITS, CHANNELS, RATE, PERIOD_SIZE, PERIOD_BYTES, PERIODS, BUFFER_SIZE, BUFFER_BYTES]) at(params, param).integer = true
  params.cmask = cmask
  params.rmask = 0
  const bits = at(params, SAMPLE_BITS)
  params.info = InfoFlags
  params.msbits = bits.min === bits.max ? bits.min : 0
  const rate = at(params, RATE)
  params.rateNum = rate.min === rate.max ? rate.min : 0
  params.rateDen = rate.min === rate.max ? 1 : 0
  return params
}

/** The one stream `HW_PARAMS` settles on, from a refined request */
export interface Stream {
  format: number
  channels: number
  rate: number
  periodSize: number
  periods: number
  bufferSize: number
  frameBytes: number
}

/** Fixes `refined` to single values, in the order Linux picks them (the first of each), and gives the stream they make */
export function choose(refined: HwParams): { params: HwParams, stream: Stream } | undefined {
  const params: HwParams = {
    ...refined,
    masks: refined.masks.map(set => new Set(set)) as HwParams['masks'],
    intervals: refined.intervals.map(value => ({ ...value }))
  }
  const first = (set: Set<number>) => Math.min(...set)
  params.masks[ACCESS] = new Set([first(params.masks[ACCESS])])
  params.masks[FORMAT] = new Set([first(params.masks[FORMAT])])
  params.masks[SUBFORMAT] = new Set([0])
  if (!settle(params)) return undefined
  // Linux's order, with sizes in place of times: the fewest channels, the lowest rate, the shortest period, then the smallest buffer of whole periods
  for (const param of [CHANNELS, RATE, PERIOD_SIZE, BUFFER_SIZE, PERIODS]) {
    const value = at(params, param)
    value.max = value.min
    if (!settle(params)) return undefined
  }
  const rate = at(params, RATE).min
  const periodSize = at(params, PERIOD_SIZE).min, bufferSize = at(params, BUFFER_SIZE).min
  const time = (frames: number) => Math.round(frames * MICROSECONDS / rate)
  for (const [param, value] of [[PERIOD_TIME, time(periodSize)], [BUFFER_TIME, time(bufferSize)], [TICK_TIME, 0]] as const) {
    const slot = at(params, param)
    slot.min = value
    slot.max = value
  }
  for (const value of params.intervals) value.empty = false
  const format = first(params.masks[FORMAT])
  const channels = at(params, CHANNELS).min
  const stream: Stream = {
    format, channels, rate, periodSize, periods: at(params, PERIODS).min, bufferSize,
    frameBytes: (bytesOf(format) ?? 2) * channels
  }
  params.rmask = 0
  params.cmask = 0xffffffff
  params.info = InfoFlags
  params.msbits = (bytesOf(format) ?? 2) * 8
  params.rateNum = rate
  params.rateDen = 1
  return { params, stream }
}
