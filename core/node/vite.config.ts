import { readFileSync } from 'node:fs'
import path from 'node:path'
import i18nextLoader from 'vite-plugin-i18next-loader'
import { defineConfig } from 'vitest/config'
import type { UserConfig } from 'vite'

import { binCommands, binKernelCommands, binNode, binPilotPwd, binPilotWindow, binWali } from '../kernel/vite-plugin-bin-node.ts'

import kernelPkg from '../kernel/package.json' with { type: 'json' }

const kernelDir = path.resolve(import.meta.dirname, '../kernel')

// `@bytecodealliance/preview2-shim`'s `node` build implements WASI against the real host filesystem and spawns a
// worker relative to its own file (which breaks once bundled). Its `browser` build keeps component-model programs
// inside the ecmaOS filesystem, which is what a guest should see.
const preview2 = path.join(kernelDir, 'node_modules/@bytecodealliance/preview2-shim/dist/browser')

export default defineConfig({
  envPrefix: 'ECMAOS_',
  // Never pick up a developer's `.env`: it would change what a built binary does (first-boot prompts, initfs URL, ...).
  envDir: false,
  publicDir: false,
  plugins: [
    // The initfs tarball ships beside the entry point; `sources.ts` serves it to the kernel from there
    { name: 'ecmaos:initfs', generateBundle() { this.emitFile({ type: 'asset', fileName: 'initfs.tar.gz', source: readFileSync(path.join(kernelDir, 'public/initfs.tar.gz')) }) } },
    binNode(),
    binWali(),
    binPilotPwd(),
    binPilotWindow(),
    binCommands(),
    binKernelCommands(),
    i18nextLoader({ namespaceResolution: 'basename', paths: [path.join(kernelDir, 'locales')] })
  ] as UserConfig['plugins'],
  define: {
    'import.meta.env.NAME': JSON.stringify(kernelPkg.name),
    'import.meta.env.VERSION': JSON.stringify(kernelPkg.version),
    'import.meta.env.XTERM_VERSION': JSON.stringify(kernelPkg.dependencies['@xterm/xterm'].replace(/^[\^~]/, '')),
    'import.meta.env.ZENFS_VERSION': JSON.stringify(kernelPkg.dependencies['@zenfs/core'].replace(/^[\^~]/, '')),
    'import.meta.env.DESCRIPTION': JSON.stringify(kernelPkg.description),
    'import.meta.env.HOMEPAGE': JSON.stringify(kernelPkg.homepage),
    'import.meta.env.REPOSITORY': JSON.stringify(kernelPkg.repository),
    'import.meta.env.AUTHOR': JSON.stringify(kernelPkg.author),
    'import.meta.env.KNOWN_ISSUES': JSON.stringify(kernelPkg.knownIssues),
    'import.meta.env.TIPS': JSON.stringify(kernelPkg.tips),
    // The initfs tarball is a URL the site serves; a Node process has no site. Bundled sources come with the persistent root.
    'import.meta.env.ECMAOS_INITFS': JSON.stringify('none'),
    'import.meta.env.ECMAOS_PROGRAMS': JSON.stringify('none')
  },
  resolve: {
    alias: [
      { find: /^@bytecodealliance\/preview2-shim$/, replacement: path.join(preview2, 'index.js') },
      { find: /^@bytecodealliance\/preview2-shim\/(?!instantiation$)(.+)$/, replacement: path.join(preview2, '$1.js') }
    ]
  },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'node24',
    rollupOptions: { output: { format: 'esm', entryFileNames: 'ecmaos.mjs', banner: (chunk) => chunk.isEntry ? '#!/usr/bin/env node' : '' } }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000
  }
})
