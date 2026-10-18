/**
 * The GL command stream a program writes to `/dev/gl<N>`: records of 32-bit little-endian words, a header word
 * (`opcode << 16 | payload words`) then the payload. Each command is one call on a WebGL2 context; its payload is its
 * arguments in order, written as the letters of `sig` say: `i` a signed 32-bit integer, `u` an unsigned one, `f` a
 * 32-bit float; `b`, `F`, `I` and `S` are a blob: a byte count (`0xffffffff` for none), then the bytes padded to a word,
 * read as bytes, 32-bit floats, 32-bit integers or text. Constants are the GL values (WebGL2 uses the same numbers as
 * OpenGL ES 3).
 *
 * The program names its objects (shaders, buffers, textures and so on) itself, so no call has to wait for an answer: a
 * `make` command creates the object and keeps it under the name in one of its arguments, and `objs` says which of the
 * other arguments are names to turn back into objects (name 0 is none).
 *
 * `gl-commands.json` is the one place the commands are defined: the decoder in `gl.ts` is driven by it, and the C
 * encoders the programs call (`core/utils/wasm/lib/sdl-gl/gen-cmds.mjs`) are generated from it.
 */

import table from './gl-commands.json'

export interface GlCommand {
  op: number
  /** The method of the WebGL2 context this command calls */
  name: string
  /** One letter per argument */
  sig: string
  /** One character per argument: `-` for a plain value, otherwise the kind of object it names */
  objs?: string
  /** The argument that names the object this command makes (it is not passed on); its kind is a letter of `objs` */
  make?: { kind: string, arg: number }
  /** The command ends the life of the object its `objs` names */
  drop?: boolean
  /** Written by hand in the C side, with the encoder generated only as a table entry */
  manual?: boolean
  /** The name of the C function when it is not `gl` plus the capitalized `name`; empty for none */
  fn?: string
  /** Tells apart commands that share a `name` */
  key?: string
  /** The C parameters of the GLES2 function, such as `GLfloat red` */
  args: string[]
}

export const GlCommands: readonly GlCommand[] = table.commands

export const GlCommandByOp: ReadonlyMap<number, GlCommand> = new Map(GlCommands.map(command => [command.op, command]))
