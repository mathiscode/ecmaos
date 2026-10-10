# ZenFS

ecmaOS is built on [ZenFS](https://github.com/zen-fs/core): `@zenfs/core` (the virtual filesystem and its
contexts and credentials), `@zenfs/linux` (processes, signals, `execve`, `/proc`, `/sys`, the syscall ABI),
`@zenfs/dom` (IndexedDB), `@zenfs/archives`, `@zenfs/cloud` and `@zenfs/emscripten`. Thank you to James Prevett and
the other ZenFS contributors.

ZenFS is licensed under the LGPL-3.0-or-later with the additional terms in `COPYING.md`, Copyright © James Prevett
and other ZenFS contributors. Each package's `LICENSE.md`, `COPYING.md` and `COPYRIGHT.txt` are in the directory
named for it here. ecmaOS itself is MIT OR Apache-2.0.

The versions are the ones the build was made with. Run `pnpm sync:licenses` in the ecmaOS repository to refresh
these files after a ZenFS upgrade.

## Using your own copy of ZenFS

You can build ecmaOS against a modified ZenFS, which is what the LGPL asks us to allow. ZenFS is a normal
dependency in the source tree, never copied into it:

1. Clone ecmaOS and run `pnpm install`.
2. Build your copy of ZenFS (`npm run build` in it), then replace the installed package's `dist` with your
   `dist`. pnpm keeps it at `node_modules/.pnpm/@zenfs+core@<version>/node_modules/@zenfs/core/dist`; the files are
   hard links into the shared pnpm store, so move the old `dist` aside and copy yours in, rather than editing in
   place. Delete the `node_modules/.vite` caches afterwards. The same goes for any other `@zenfs/*` package.
3. Rebuild: `pnpm build` for the site and the kernel bundle, and `pnpm --filter @ecmaos/node build` for
   `dist/ecmaos.mjs`, the Node host, which has ZenFS bundled into it.

Nothing in the ecmaOS licenses forbids modifying the result or reverse engineering it to debug your changes.
