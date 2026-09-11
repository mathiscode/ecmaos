/**
 * The bundled source of `/bin/wali`, ecmaOS's real `execve` interpreter for WALI-format WASM
 * modules. See `vite-plugin-bin-node.ts` and `src/bin/wali.mjs` for what generates this and why it
 * must be one self-contained module with no import statements.
 */
declare module 'virtual:bin-wali' {
  const binWaliSource: string
  export default binWaliSource
}
