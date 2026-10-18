/**
 * The GL command stream a program writes to `/dev/gl<N>`: records of 32-bit little-endian words, a header word
 * (`opcode << 16 | payload words`) then the payload. Each command is one call on a WebGL2 context; its payload is its
 * arguments in order, written as the letters of `sig` say: `i` a signed 32-bit integer, `u` an unsigned one, `f` a
 * 32-bit float. Constants are the GL values (WebGL2 uses the same numbers as OpenGL ES 3).
 *
 * The table is the one place the commands are defined: the decoder in `gl.ts` is driven by it, and the C header the
 * programs encode with is generated from it.
 */

export interface GlCommand {
  op: number
  /** The method of the WebGL2 context this command calls */
  name: string
  /** One letter per argument */
  sig: string
}

export const GlCommands: readonly GlCommand[] = [
  { op: 1, name: 'clearColor', sig: 'ffff' },
  { op: 2, name: 'clear', sig: 'u' },
  { op: 3, name: 'viewport', sig: 'iiii' }
]

export const GlCommandByOp: ReadonlyMap<number, GlCommand> = new Map(GlCommands.map(command => [command.op, command]))
