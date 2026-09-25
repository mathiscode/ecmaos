/**
 * TypeScript 7 is the native (Go) compiler: its `typescript` package ships the `tsc` binary but no
 * classic JS API (`ts.createProgram` and friends). Our own packages only run `tsc`, so they take
 * TypeScript 7 directly. Third-party tools that `require('typescript')` for the API --
 * typescript-eslint, vite-plugin-dts/api-extractor, typedoc -- still need the JS compiler, so every
 * non-workspace package that asks for `typescript` (as a dependency or a peer) gets its own
 * TypeScript 6 instead of resolving the workspace's TypeScript 7.
 */
const TYPESCRIPT_API = '^6.0.3'

function isWorkspacePackage(name) {
  return name === 'ecmaos' || /^@ecmaos(-[a-z]+)?\//.test(name ?? '')
}

function readPackage(pkg) {
  if (isWorkspacePackage(pkg.name)) return pkg

  const wantsTypescript = pkg.dependencies?.typescript || pkg.peerDependencies?.typescript
  if (!wantsTypescript) return pkg

  pkg.dependencies = { ...pkg.dependencies, typescript: TYPESCRIPT_API }
  if (pkg.peerDependencies) delete pkg.peerDependencies.typescript
  if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript
  return pkg
}

module.exports = {
  hooks: {
    readPackage
  }
}
