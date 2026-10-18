import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ioctl } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { GlCommands } from '#lib/gl-commands.ts'
import { GL_DESTROY, GL_GETINFO, GL_REPLY, GL_RESIZE, GL_SWAP, GLCTL_CREATE, MaxGlContexts, destroyGlContext, glContextAt, registerGlControl, setGlSurfaceFactory } from '#lib/gl.ts'

import { fakeGlSurfaces } from './fixtures/fake-gl'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const words = (...parts: Array<[number, 'f' | 'i' | 'u', number[]]>) => {
  const total = parts.reduce((sum, [, , values]) => sum + 1 + values.length, 0)
  const out = new Uint8Array(total * 4)
  const view = new DataView(out.buffer)
  let at = 0
  for (const [op, letter, values] of parts) {
    view.setUint32(at, ((op << 16) | values.length) >>> 0, true)
    at += 4
    for (const value of values) {
      if (letter === 'f') view.setFloat32(at, value, true)
      else if (letter === 'i') view.setInt32(at, value, true)
      else view.setUint32(at, value, true)
      at += 4
    }
  }
  return out
}
/** A record for the command called `name` (and tagged `key` when several share it), from values in the order of its signature */
const record = (name: string, ...values: unknown[]) => {
  const command = GlCommands.find(c => (c.key ?? c.name) === name)!
  const out: number[] = []
  const bytes = new ArrayBuffer(4)
  const view = new DataView(bytes)
  const word = (set: (view: DataView) => void) => { set(view); out.push(view.getUint32(0, true)) }
  ;[...command.sig].forEach((letter, i) => {
    const value = values[i]
    if (letter === 'f') return word(v => v.setFloat32(0, value as number, true))
    if (letter === 'i') return word(v => v.setInt32(0, value as number, true))
    if (letter === 'u') return word(v => v.setUint32(0, value as number, true))
    if (value === null) return out.push(0xffffffff)
    const data = letter === 'S' ? new TextEncoder().encode(value as string) : new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength)
    out.push(data.length)
    const padded = new Uint8Array(Math.ceil(data.length / 4) * 4)
    padded.set(data)
    const dv = new DataView(padded.buffer)
    for (let at = 0; at < padded.length; at += 4) out.push(dv.getUint32(at, true))
  })
  return new Uint32Array([((command.op << 16) | out.length) >>> 0, ...out])
}
const join = (...records: Uint32Array[]) => { const all = new Uint32Array(records.reduce((n, r) => n + r.length, 0)); let at = 0; for (const r of records) { all.set(r, at); at += r.length } return new Uint8Array(all.buffer) }
const size = (width: number, height: number) => words([0, 'u', [width, height]]).subarray(4)
const u32 = (bytes: Uint8Array, at = 0) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true)

describe('/dev/gl<N>', () => {
  let kernel: Kernel
  const { made: surfaces, factory } = fakeGlSurfaces()

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    setGlSurfaceFactory(factory)
  })

  afterEach(() => { for (let i = 0; i < MaxGlContexts; i++) destroyGlContext(i) })

  const create = async (width: number, height: number) => {
    const index = u32(await ioctl('/dev/glctl', GLCTL_CREATE, size(width, height)) as Uint8Array)
    return { index, path: `/dev/gl${index}` }
  }
  const frameOf = async (path: string) => {
    const handle = await kernel.filesystem.fs.open(path, 'r')
    try {
      const info = await ioctl(path, GL_GETINFO) as Uint8Array
      const out = new Uint8Array(u32(info, 0) * u32(info, 4) * 4)
      await handle.read(out, 0, out.length, null)
      return out
    } finally { await handle.close() }
  }

  it('has a control node on major 227 that makes a context and its node', async () => {
    expect(registerGlControl()).toBe(true)
    const control = await kernel.filesystem.fs.stat('/dev/glctl')
    expect(control.isCharacterDevice()).toBe(true)
    expect(Number(BigInt(control.rdev) >> 20n)).toBe(227)
    const { index, path } = await create(4, 2)
    const stat = await kernel.filesystem.fs.stat(path)
    expect(Number(BigInt(stat.rdev) & 0xfffffn)).toBe(index)
    expect(u32(await ioctl(path, GL_GETINFO) as Uint8Array, 0)).toBe(4)
    destroyGlContext(index)
    await expect(kernel.filesystem.fs.stat(path)).rejects.toThrow()
  })

  it('draws the commands written to it and hands the picture back as blue-first pixels, top row first', async () => {
    const { path } = await create(3, 2)
    await kernel.filesystem.fs.writeFile(path, join(record('clearColor', 1, 0.5, 0, 1), record('clear', 0x4000), record('viewport', 0, 0, 3, 2)))
    expect(surfaces.at(-1)!.viewports).toEqual([[0, 0, 3, 2]])
    expect(u32(await ioctl(path, GL_SWAP) as Uint8Array)).toBe(1)
    const frame = await frameOf(path)
    expect(frame.length).toBe(3 * 2 * 4)
    expect([...frame.subarray(0, 4)]).toEqual([0, 128, 255, 255])   // blue, green, red, opaque
  })

  it('flips the rows: GL reads from the bottom, the frame starts at the top', async () => {
    const { path } = await create(2, 3)
    const fake = surfaces.at(-1)!
    for (let row = 0; row < 3; row++) for (let x = 0; x < 2; x++) fake.buffer.set([row * 10, 0, 0, 255], (row * 2 + x) * 4)   // red is the row from the bottom
    await ioctl(path, GL_SWAP)
    const frame = await frameOf(path)
    expect([frame[2], frame[2 * 4 + 2], frame[4 * 4 + 2]]).toEqual([20, 10, 0])
  })

  it('waits for the rest of a command that was written in pieces, and refuses one it does not know', async () => {
    const { path } = await create(2, 2)
    const stream = join(record('clearColor', 0, 1, 0, 1), record('clear', 0x4000))
    await kernel.filesystem.fs.writeFile(path, stream.subarray(0, 10))
    expect(surfaces.at(-1)!.color).toEqual([0, 0, 0, 0])
    await kernel.filesystem.fs.writeFile(path, stream.subarray(10))
    expect(surfaces.at(-1)!.color).toEqual([0, 1, 0, 1])
    await expect(kernel.filesystem.fs.writeFile(path, words([999, 'u', [1]]))).rejects.toThrow()
    expect(u32(await ioctl(path, GL_GETINFO) as Uint8Array, 12)).toBe(0x10000)
  })

  it('keeps the objects a program names, and turns the names back into objects', async () => {
    const { path } = await create(2, 2)
    const fake = surfaces.at(-1)!
    const matrix = new Float32Array(16).map((_, i) => i)
    await kernel.filesystem.fs.writeFile(path, join(
      record('createShader', 0x8b31, 1), record('shaderSource', 1, 'void main() {}'), record('compileShader', 1),
      record('createProgram', 2), record('attachShader', 2, 1), record('bindAttribLocation', 2, 0, 'aPos'), record('linkProgram', 2),
      record('getUniformLocation', 2, 'uMvp', 5), record('useProgram', 2), record('uniformMatrix4fv', 5, 0, matrix),
      record('uniform1f', 5, 0.5), record('uniform1f', 9, 1),
      record('createBuffer', 3), record('bindBuffer', 0x8892, 3),
      record('bufferDataSize', 0x8892, 12, 0x88e4), record('bufferSubData', 0x8892, 4, new Uint8Array([1, 2, 3])),
      record('deleteShader', 1), record('attachShader', 2, 1), record('bindBuffer', 0x8892, 0)
    ))
    const call = (name: string, n = 0) => fake.calls.filter(([method]) => method === name)[n]![1]
    const shader = fake.calls.find(([m]) => m === 'createShader')![1]
    expect(shader).toEqual([0x8b31])
    expect(call('shaderSource')[0]).toBe(call('compileShader')[0])
    expect(call('shaderSource')[1]).toBe('void main() {}')
    expect(call('attachShader', 0)).toEqual([call('useProgram')[0], call('shaderSource')[0]])
    expect(call('bindAttribLocation')).toEqual([call('useProgram')[0], 0, 'aPos'])
    expect(call('uniformMatrix4fv')[0]).toBe(fake.calls.find(([m]) => m === 'getUniformLocation')!.length && call('uniform1f', 0)[0])
    expect([call('uniformMatrix4fv')[1], [...(call('uniformMatrix4fv')[2] as Float32Array)]]).toEqual([false, [...matrix]].map((v, i) => i ? v : 0))
    expect(call('uniform1f', 1)[0]).toBeNull()   // a location nobody made
    expect(call('bufferData')).toEqual([0x8892, 12, 0x88e4])
    expect([...(call('bufferSubData')[2] as Uint8Array)]).toEqual([1, 2, 3])
    expect(call('attachShader', 1)[1]).toBeNull()   // deleted: its name is no object now
    expect(call('bindBuffer', 1)).toEqual([0x8892, null])
  })

  it('takes a texture with no pixels as a null, and refuses a blob longer than its record', async () => {
    const { path } = await create(2, 2)
    const fake = surfaces.at(-1)!
    await kernel.filesystem.fs.writeFile(path, join(record('texImage2D', 0xde1, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, null)))
    expect(fake.calls.at(-1)).toEqual(['texImage2D', [0xde1, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, null]])
    const bad = record('shaderSource', 1, 'abcd')
    bad[2] = 400   // claims more bytes than the record holds
    await expect(kernel.filesystem.fs.writeFile(path, new Uint8Array(bad.buffer))).rejects.toThrow()
  })

  it('answers questions in the order they were asked, a part at a time, and with zeros when the call fails', async () => {
    const { path } = await create(2, 2)
    const fake = surfaces.at(-1)!
    const taken = async () => { const out = await ioctl(path, GL_REPLY) as Uint8Array; return out.subarray(4, 4 + u32(out)) }
    fake.answers.getAttribLocation = 3
    fake.answers.getProgramParameter = true
    fake.answers.getShaderInfoLog = 'line 1: error'
    fake.answers.getParameter = (name: number) => name === 0xba2 ? new Int32Array([0, 0, 2, 2]) : undefined
    fake.answers.getActiveUniform = { size: 2, type: 0x8b52, name: 'uMvp' }
    await kernel.filesystem.fs.writeFile(path, join(
      record('createProgram', 1), record('getAttribLocation', 1, 'aPos'), record('getProgramiv', 1, 0x8b82),
      record('createShader', 0x8b30, 2), record('getShaderInfoLog', 2), record('getIntegerv', 0xba2), record('getFloatv', 0xb21),
      record('getActiveUniform', 1, 0), record('checkFramebufferStatus', 0x8d40)))
    const bytes = await taken()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getInt32(0, true)).toBe(3)
    expect(view.getInt32(4, true)).toBe(1)   // true is 1
    expect([view.getUint32(8, true), new TextDecoder().decode(bytes.subarray(12, 25))]).toEqual([13, 'line 1: error'])
    expect([view.getUint32(25, true), view.getInt32(29, true), view.getInt32(41, true)]).toEqual([4, 0, 2])
    expect(view.getUint32(45, true)).toBe(0)   // getFloatv of nothing: no values
    expect([view.getInt32(49, true), view.getUint32(53, true), view.getUint32(57, true)]).toEqual([2, 0x8b52, 4])
    expect(bytes.length).toBe(61 + 4 + 4)   // "uMvp", then the status the fake gave no answer for: a zero word
    expect((await taken()).length).toBe(0)
    // a big answer comes in parts of at most GlReplyMax
    await kernel.filesystem.fs.writeFile(path, join(record('readPixels', 0, 0, 2, 2, 0x1908, 0x1401)))
    expect((await taken()).length).toBe(16)
  })

  it('resizes, numbers contexts from the lowest free one, refuses a bad size and a full table', async () => {
    const a = await create(2, 2)
    const b = await create(2, 2)
    expect(b.index).toBe(a.index + 1)
    await ioctl(a.path, GL_RESIZE, size(5, 4))
    expect(glContextAt(a.index)!.frame.length).toBe(5 * 4 * 4)
    await expect(ioctl('/dev/glctl', GLCTL_CREATE, size(0, 4))).rejects.toThrow()
    await expect(ioctl('/dev/glctl', GLCTL_CREATE, size(9999, 4))).rejects.toThrow()
    await ioctl(a.path, GL_DESTROY)
    expect((await create(2, 2)).index).toBe(a.index)
    for (let i = 0; i < MaxGlContexts - 2; i++) await create(1, 1)
    await expect(ioctl('/dev/glctl', GLCTL_CREATE, size(1, 1))).rejects.toThrow()
  })
})
