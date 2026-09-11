/**
 * The bundled source of the real, syscall-only coreutil pilot (`src/bin/pilot-pwd.mjs`). See
 * `vite-plugin-bin-node.ts` for what generates this and why it must be one self-contained module
 * with no import statements.
 */
declare module 'virtual:bin-pilot-pwd' {
  const binPilotPwdSource: string
  export default binPilotPwdSource
}
