# ZenFS and its libraries

ecmaOS is built on [ZenFS](https://github.com/zen-fs/core): `@zenfs/core` (the virtual filesystem and its
contexts and credentials), `@zenfs/linux` (processes, signals, `execve`, `/proc`, `/sys`, the syscall ABI),
`@zenfs/dom` (IndexedDB), `@zenfs/archives`, `@zenfs/cloud`, `@zenfs/emscripten` and `@zenfs/streams`, and on two
libraries by the same author that ZenFS is built on, [utilium](https://github.com/james-pre/utilium) and
[memium](https://github.com/james-pre/memium). Thank you to James Prevett and the other ZenFS contributors.

All of them are licensed under the LGPL-3.0-or-later, Copyright © James Prevett and other contributors. Each package's
`LICENSE.md` (and, for the `@zenfs/*` packages, `COPYING.md` and `COPYRIGHT.txt`) is in the directory named for it
here or beside this one. ecmaOS itself is MIT OR Apache-2.0.

- **The `@zenfs/*` packages** come with `COPYING.md`, which lets a web application that is only used over a network be
  conveyed without the LGPL's section 4(d) (the relinking requirement), and says bundling and minifying them in one is
  fine. The ecmaOS site is such an application; ZenFS is not modified.
- **`utilium` and `memium`** are the plain LGPL, with no such exception. ecmaOS conveys them in a combined work under
  section 4(d)(0): ecmaOS's whole source is public and under licenses that permit modification, so you can recombine it
  with a version of the library of your own, with the steps below. The Node host (`@ecmaos/node`) and the desktop app
  (`@ecmaos/jaffa`) are not web applications, so the same goes for all of the libraries in them.

The versions are the ones the build was made with. Run `pnpm sync:licenses` in the ecmaOS repository to refresh
these files after an upgrade of any of them.

## Using your own copy

You can build ecmaOS against a modified copy of any of these libraries, which is what the LGPL asks us to allow. They
are normal dependencies in the source tree, never copied into it:

1. Clone ecmaOS (https://github.com/ecmaos/ecmaos, at the tag of the release you have) and run `pnpm install`.
2. Build your copy of the library (`npm run build` in it), then replace the installed package's `dist` with your
   `dist`. pnpm keeps it at `node_modules/.pnpm/<name>@<version>/node_modules/<name>/dist` (for example
   `@zenfs+core@<version>/node_modules/@zenfs/core/dist`); the files are hard links into the shared pnpm store, so
   move the old `dist` aside and copy yours in, rather than editing in place. Delete the `node_modules/.vite` caches
   afterwards.
3. Rebuild: `pnpm build` for the site and the kernel bundle, `pnpm --filter @ecmaos/node build` for
   `dist/ecmaos.mjs`, the Node host, which has the libraries bundled into it, and `pnpm --filter @ecmaos/jaffa build:tauri`
   for the desktop app.

Nothing in the ecmaOS licenses forbids modifying the result or reverse engineering it to debug your changes.
