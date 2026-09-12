/**
 * The bundled source of every kernel-native command migrated onto real `execve` so far, keyed by
 * command name. See `vite-plugin-bin-node.ts`'s `binKernelCommands`/`migratedKernelCommands` for what
 * generates this.
 */
declare module 'virtual:bin-kernel-commands' {
  const binKernelCommandsSource: Record<string, string>
  export default binKernelCommandsSource
}
