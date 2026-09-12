/**
 * The bundled source of the main-thread-syscall-bridge pilot (`src/bin/pilot-window.mjs`). See
 * `vite-plugin-bin-node.ts` for what generates this and why it must be one self-contained module
 * with no import statements.
 */
declare module 'virtual:bin-pilot-window' {
  const binPilotWindowSource: string
  export default binPilotWindowSource
}
