// @ts-expect-error the shim ships no resolvable types
import processShim from 'vite-plugin-node-polyfills/shims/process'

/**
 * The kernel reads and writes `globalThis.process` (`env`, `argv`). `vite-plugin-node-polyfills` only defines it in dev
 * (its banner is applied to pre-bundled dependencies), and a production build injects the shim just where code uses a bare
 * `process`, so `globalThis.process` is undefined in a built page and the kernel threw while constructing. Where a real
 * `process` exists (Node, vitest) this does nothing. Import it before anything else.
 */
const scope = globalThis as { process?: unknown }
scope.process ??= processShim
