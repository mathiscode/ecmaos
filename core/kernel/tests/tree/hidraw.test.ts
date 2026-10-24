import { beforeAll, describe, expect, it } from 'vitest'
import { ioctl } from '@zenfs/core'

import { reportDescriptor, usesReportIds } from '@ecmaos-devices/hid'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const field = (overrides: Partial<HIDReportItem>): HIDReportItem => ({
  isAbsolute: true, isArray: false, isConstant: false, isLinear: true, hasPreferredState: true, hasNull: false, wrap: false,
  reportSize: 8, reportCount: 1, logicalMinimum: 0, logicalMaximum: 255, usages: [], ...overrides
})

/** A controller that numbers its reports: input 1 (4 bytes), output 2 (2 bytes), feature 5 (3 bytes) */
const padCollections: HIDCollectionInfo[] = [{
  usagePage: 1, usage: 5, type: 1,
  inputReports: [{ reportId: 1, items: [
    field({ usages: [0x10030, 0x10031], reportSize: 8, reportCount: 2, logicalMinimum: -128, logicalMaximum: 127 }),
    field({ isRange: true, usageMinimum: 0x90001, usageMaximum: 0x90008, reportSize: 1, reportCount: 8, logicalMaximum: 1 }),
    field({ isConstant: true, reportSize: 8, reportCount: 1, logicalMaximum: 0 })
  ] }],
  outputReports: [{ reportId: 2, items: [field({ usages: [0xff000001], reportSize: 8, reportCount: 2, isVolatile: true })] }],
  featureReports: [{ reportId: 5, items: [field({ usages: [0xff000002], reportSize: 8, reportCount: 3 })] }],
  children: []
}]

/** A mouse: one report, no id */
const mouseCollections: HIDCollectionInfo[] = [{
  usagePage: 1, usage: 2, type: 1,
  inputReports: [{ reportId: 0, items: [field({ isRange: true, usageMinimum: 0x90001, usageMaximum: 0x90003, reportSize: 1, reportCount: 3, logicalMaximum: 1 }), field({ usages: [0x10030, 0x10031], reportSize: 8, reportCount: 2, isAbsolute: false, logicalMinimum: -127, logicalMaximum: 127 })] }],
  outputReports: [], featureReports: [], children: []
}]

class FakeHid extends EventTarget {
  opened = false
  sent: Array<[number, number[]]> = []
  features = new Map<number, number[]>([[5, [9, 8, 7]]])
  constructor(readonly vendorId: number, readonly productId: number, readonly productName: string, readonly collections: HIDCollectionInfo[]) { super() }
  async open() { this.opened = true }
  async close() { this.opened = false }
  async sendReport(id: number, data: Uint8Array) { this.sent.push([id, [...data]]) }
  async receiveFeatureReport(id: number) { return new DataView(new Uint8Array(this.features.get(id) ?? []).buffer) }
  async sendFeatureReport(id: number, data: Uint8Array) { this.features.set(id, [...data]) }
  report(id: number, ...bytes: number[]) {
    const event = new Event('inputreport') as Event & { reportId: number, data: DataView }
    event.reportId = id
    event.data = new DataView(new Uint8Array(bytes).buffer)
    this.dispatchEvent(event)
  }
}

/** The sizes in bits of each report that a descriptor lays out, read by a parser that shares nothing with the writer */
function layout(descriptor: Uint8Array) {
  const sizes = new Map<string, number>()
  let size = 0, count = 0, id = 0, depth = 0
  for (let i = 0; i < descriptor.length;) {
    const prefix = descriptor[i]!
    const length = (prefix & 3) === 3 ? 4 : prefix & 3
    let value = 0
    for (let j = 0; j < length; j++) value |= descriptor[i + 1 + j]! << (8 * j)
    i += 1 + length
    const tag = prefix & 0xfc
    if (tag === 0x74) size = value
    else if (tag === 0x94) count = value
    else if (tag === 0x84) id = value
    else if (tag === 0xa0) depth++
    else if (tag === 0xc0) depth--
    else if (tag === 0x80 || tag === 0x90 || tag === 0xb0) {
      const key = `${{ 0x80: 'input', 0x90: 'output', 0xb0: 'feature' }[tag]}:${id}`
      sizes.set(key, (sizes.get(key) ?? 0) + size * count)
    }
  }
  expect(depth).toBe(0)
  return Object.fromEntries(sizes)
}

describe('the report descriptor made from WebHID collections', () => {
  it('lays out every report as the collections do, and says whether reports are numbered', () => {
    expect(layout(reportDescriptor(padCollections))).toEqual({ 'input:1': 16 + 8 + 8, 'output:2': 16, 'feature:5': 24 })
    expect(layout(reportDescriptor(mouseCollections))).toEqual({ 'input:0': 3 + 16 })
    expect(usesReportIds(padCollections)).toBe(true)
    expect(usesReportIds(mouseCollections)).toBe(false)
  })

  it('writes the items a parser needs: usage page, usage, collection, signed limits, and the flags', () => {
    const bytes = [...reportDescriptor(mouseCollections)]
    expect(bytes.slice(0, 5)).toEqual([0x05, 0x01, 0x09, 0x02, 0xa1]) // Usage Page (Generic Desktop), Usage (Mouse), Collection
    expect(bytes.at(-1)).toBe(0xc0)
    // logical minimum -127 as one signed byte, logical maximum 127
    const at = bytes.findIndex((byte, i) => byte === 0x15 && bytes[i + 1] === 0x81 && bytes[i + 2] === 0x25)
    expect(at).toBeGreaterThan(0)
    // the relative axes are Input (Data, Variable, Relative)
    expect(bytes.join(',')).toContain('129,6')
  })
})

describe('a WebHID device as /dev/hidraw<n>', () => {
  let kernel: Kernel
  const pad = new FakeHid(0x054c, 0x09cc, 'Wireless Controller', padCollections)
  const mouse = new FakeHid(0x046d, 0xc077, 'USB Optical Mouse', mouseCollections)

  beforeAll(async () => {
    Object.defineProperty(globalThis.navigator, 'hid', {
      value: Object.assign(new EventTarget(), { getDevices: async () => [pad, mouse] }),
      configurable: true
    })
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  })

  const IOC_READ = 2, IOC_WRITE = 1
  const request = (direction: number, number: number, size: number) => ((direction << 30) | (size << 16) | (0x48 << 8) | number) >>> 0
  const read = async (path: string, number: number, size: number) => await ioctl(path, request(IOC_READ, number, size)) as Uint8Array
  const ints = (bytes: Uint8Array) => Array.from({ length: bytes.length >> 2 }, (_, i) => new DataView(bytes.buffer, bytes.byteOffset).getInt32(i * 4, true))
  const string = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0.*$/s, '')

  it('answers HIDIOCGRAWINFO, GRAWNAME and GRAWPHYS', async () => {
    const info = new DataView((await read('/dev/hidraw0', 3, 8)).buffer.slice(0))
    expect([info.getUint32(0, true), info.getInt16(4, true), info.getInt16(6, true)]).toEqual([3, 0x054c, 0x09cc])
    expect(string(await read('/dev/hidraw0', 4, 256))).toBe('Wireless Controller')
    expect(string(await read('/dev/hidraw1', 4, 256))).toBe('USB Optical Mouse')
    expect(string(await read('/dev/hidraw0', 5, 256))).toBe('webhid-054c:09cc/input0')
    // a name that does not fit is cut, and still ends in a NUL
    const short = await read('/dev/hidraw0', 4, 8)
    expect(short.length).toBe(8)
    expect(short[7]).toBe(0)
  })

  it('gives the descriptor and its size, which agree', async () => {
    const [size] = ints(await read('/dev/hidraw0', 1, 4))
    const reply = await read('/dev/hidraw0', 2, 4100)
    expect(new DataView(reply.buffer).getUint32(0, true)).toBe(size)
    expect(Array.from(reply.subarray(4, 4 + size!))).toEqual(Array.from(reportDescriptor(padCollections)))
  })

  it('HIDIOCGFEATURE gives the report with its id in front, and SFEATURE sends one', async () => {
    const buffer = new Uint8Array(4)
    buffer[0] = 5
    const got = await ioctl('/dev/hidraw0', request(IOC_READ | IOC_WRITE, 7, 4), buffer) as Uint8Array
    expect(Array.from(got)).toEqual([5, 9, 8, 7])
    const sent = await ioctl('/dev/hidraw0', request(IOC_READ | IOC_WRITE, 6, 3), Uint8Array.of(5, 1, 2))
    expect(sent).toBe(3)
    expect(pad.features.get(5)).toEqual([1, 2])
  })

  it('numbered reports are read with their id; unnumbered ones without', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/hidraw.js', `
      const { open, close, read, write } = globalThis.ecmaosSyscalls
      const out = []
      const numbered = open('/dev/hidraw0', 2, 0)
      const plain = open('/dev/hidraw1', 2, 0)
      const buf = new Uint8Array(16)
      const take = fd => out.push(Array.from(buf.subarray(0, read(fd, buf, -1))).join(','))
      take(numbered)
      take(plain)
      write(numbered, Uint8Array.of(2, 7, 8))
      write(plain, Uint8Array.of(0, 4))
      close(numbered); close(plain)
      const file = open('/tmp/hidraw-result', 1 | 64 | 512, 0o644)
      write(file, new TextEncoder().encode(out.join('|')))
      close(file)
    `, { mode: 0o755 })
    // the devices open when the nodes do, so the reports are raised until the program has taken one of each
    const raising = setInterval(() => { pad.report(1, 10, 20, 0, 0); mouse.report(0, 1, 2, 3) }, 10)
    try { expect(await kernel.shell.execute('/tmp/hidraw.js')).toBe(0) } finally { clearInterval(raising) }
    expect(await kernel.filesystem.fs.readFile('/tmp/hidraw-result', 'utf8')).toBe('1,10,20,0,0|1,2,3')
    expect(pad.sent).toContainEqual([2, [7, 8]])
    expect(mouse.sent).toContainEqual([0, [4]])
  })

  it('hidinfo, a WALI program, lists the devices and reads the descriptor and a feature report', async () => {
    const fs = kernel.filesystem.fs
    expect(await kernel.shell.execute('hidinfo -d -f 5 > /tmp/hidinfo.out 2> /tmp/hidinfo.err')).toBe(0)
    expect(await fs.readFile('/tmp/hidinfo.err', 'utf8')).toBe('')
    const out = await fs.readFile('/tmp/hidinfo.out', 'utf8')
    const descriptor = reportDescriptor(padCollections)
    expect(out).toContain('/dev/hidraw0: Wireless Controller\n  bus 3, vendor 054c, product 09cc\n  phys webhid-054c:09cc/input0\n  report descriptor ' + descriptor.length + ' bytes\n')
    expect(out).toContain('/dev/hidraw1: USB Optical Mouse\n  bus 3, vendor 046d, product c077\n')
    expect(out).toContain(Array.from(descriptor.subarray(0, 6), byte => byte.toString(16).padStart(2, '0')).join(' '))
    expect(out).toContain('feature report 5: 05 01 02')
  }, 60000)
})
