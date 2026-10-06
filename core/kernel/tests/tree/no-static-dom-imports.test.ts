import { describe, expect, it } from 'vitest'

// The vitest config aliases `node:fs` to a browser shim; reach the real module instead.
const { readdirSync, readFileSync } = process.getBuiltinModule('node:fs')
const { join } = process.getBuiltinModule('node:path')

/**
 * These packages touch `window`, `document` or `self` at import time (or patch globals), which breaks a
 * non-browser host. They must be loaded with `import()` where a DOM exists, never statically. A bare-Node
 * import of the built bundle is checked by the Node smoke test; this guard catches the regression early.
 */
const DomOnly = [
  'topbar',
  'notyf',
  'winbox',
  '@xterm/addon-clipboard',
  '@opentelemetry/context-zone',
  '@opentelemetry/sdk-trace-web',
  '@opentelemetry/instrumentation-document-load',
  '@opentelemetry/instrumentation',
  '@opentelemetry/exporter-trace-otlp-http',
  'zone.js'
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|mjs)$/.test(entry.name) ? [path] : []
  })
}

describe('kernel sources', () => {
  it('import DOM-only packages dynamically, never statically', () => {
    const offenders: string[] = []

    for (const file of sources(join(__dirname, '../../src/tree'))) {
      const text = readFileSync(file, 'utf8')
      for (const pkg of DomOnly) {
        const escaped = pkg.replace(/[/@.]/g, '\\$&')
        // `import x from 'pkg'`, `import 'pkg'`, `export ... from 'pkg'` (type-only imports are erased and allowed)
        const staticImport = new RegExp(`^(?:import(?!\\s+type\\b)[^\\n]*?|export(?!\\s+type\\b)[^\\n]*?\\sfrom)\\s*['"]${escaped}(?:/[^'"]*)?['"]`, 'm')
        if (staticImport.test(text)) offenders.push(`${file}: ${pkg}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
