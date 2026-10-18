import type { GlLike, GlSurface } from '#lib/gl.ts'

/** A WebGL2 with a color buffer and nothing else: `clear` fills it, and rows are read from the bottom up like GL's */
export class FakeGl {
  readonly RGBA = 0x1908
  readonly UNSIGNED_BYTE = 0x1401
  readonly NO_ERROR = 0
  color = [0, 0, 0, 0]
  /** Every call the fake has no behavior for, in order: the method and its arguments */
  calls: Array<[string, unknown[]]> = []
  made = 0
  /** What a question gets for an answer, by method: a value, or a function of the arguments */
  answers: Record<string, unknown> = { getShaderParameter: true, getProgramParameter: true, getAttribLocation: (_program: unknown, name: string) => name === 'aPos' ? 0 : 1 }
  viewports: number[][] = []
  buffer: Uint8Array
  constructor(public width: number, public height: number) { this.buffer = new Uint8Array(width * height * 4) }
  clearColor(r: number, g: number, b: number, a: number) { this.color = [r, g, b, a] }
  clear(mask: number) {
    if (!(mask & 0x4000)) return
    for (let i = 0; i < this.width * this.height; i++) this.buffer.set(this.color.map(c => Math.round(c * 255)), i * 4)
  }
  viewport(x: number, y: number, w: number, h: number) { this.viewports.push([x, y, w, h]) }
  readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, into: Uint8Array) { into.set(this.buffer.subarray(0, into.length)) }
  getError() { return 0 }
}

/** A surface factory (see `setGlSurfaceFactory`) that makes fakes and keeps them in `made` */
export function fakeGlSurfaces(made: FakeGl[] = []) {
  return {
    made,
    factory: (width: number, height: number): GlSurface => {
      const fake = new FakeGl(width, height)
      made.push(fake)
      // anything else is a call to record; the ones that make an object answer with a new one
      const gl = new Proxy(fake, {
        get: (target, key, receiver) => {
          if (typeof key !== 'string' || key in target) return Reflect.get(target, key, receiver)
          return (...args: unknown[]) => {
            target.calls.push([key, args])
            if (key in target.answers) { const answer = target.answers[key]; return typeof answer === 'function' ? answer(...args) : answer }
            return key.startsWith('create') || key === 'getUniformLocation' ? { made: key, number: ++target.made } : undefined
          }
        }
      })
      return { gl: gl as unknown as GlLike, resize(w, h) { fake.width = w; fake.height = h; fake.buffer = new Uint8Array(w * h * 4) }, destroy() {} }
    }
  }
}
