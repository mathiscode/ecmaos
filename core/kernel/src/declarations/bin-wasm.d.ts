/**
 * Prebuilt WebAssembly programs (`src/bin/wasm/*.wasm`), base64-encoded and keyed by command name.
 * See `vite-plugin-bin-node.ts`'s `binWasm` for what generates this.
 */
declare module 'virtual:bin-wasm' {
  const binWasmSources: Record<string, string>
  export default binWasmSources
}
