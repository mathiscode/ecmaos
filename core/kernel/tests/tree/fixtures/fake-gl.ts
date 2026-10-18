import type { GlLike, GlSurface } from '#lib/gl.ts'

/** A WebGL2 with a color buffer and nothing else: `clear` fills it, and rows are read from the bottom up like GL's */
export class FakeGl {
  readonly RGBA = 0x1908
  readonly UNSIGNED_BYTE = 0x1401
  readonly NO_ERROR = 0
  color = [0, 0, 0, 0]
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
      const gl = new FakeGl(width, height)
      made.push(gl)
      return { gl: gl as unknown as GlLike, resize(w, h) { gl.width = w; gl.height = h; gl.buffer = new Uint8Array(w * h * 4) }, destroy() {} }
    }
  }
}
