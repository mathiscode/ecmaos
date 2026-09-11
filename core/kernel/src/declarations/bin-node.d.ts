/**
 * The bundled source of `/bin/node`, ecmaOS's real `execve` interpreter for plain JS/ESM programs.
 * See `vite-plugin-bin-node.ts` and `src/bin/node.mjs` for what generates this and why it must be
 * one self-contained module with no import statements.
 */
declare module 'virtual:bin-node' {
  const binNodeSource: string
  export default binNodeSource
}
