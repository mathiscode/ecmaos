/**
 * The bundled source of every coreutil migrated onto real `execve` so far, keyed by command name.
 * See `vite-plugin-bin-node.ts`'s `binCommands`/`migratedCommands` for what generates this.
 */
declare module 'virtual:bin-commands' {
  const binCommandsSource: Record<string, string>
  export default binCommandsSource
}
