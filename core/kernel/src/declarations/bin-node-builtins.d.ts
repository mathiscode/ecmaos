/**
 * The Node built-in modules and the ES module converter, bundled: each file's path under `/usr/lib/node` and its source.
 * See `vite-plugin-bin-node.ts`'s `binNodeBuiltins` and `src/bin/node-builtins/`.
 */
declare module 'virtual:bin-node-builtins' {
  const binNodeBuiltins: Record<string, string>
  export default binNodeBuiltins
}
