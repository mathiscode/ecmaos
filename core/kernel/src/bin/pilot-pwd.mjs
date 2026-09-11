/**
 * Pilot: a real, worker-hosted coreutil-shaped program, proving the infrastructure a genuine
 * `execve`'d coreutil would need actually works end to end -- not a plumbing exercise like
 * `coreutils-ctx`'s signature codemod, a real one. See `Kernel.executeViaExecve`'s doc comment and
 * `.docs/overhaul/STATUS_01.md` for why coreutils don't run this way today (they reach live
 * `kernel`/`shell`/`terminal` JS object references directly -- 792 call sites across the 108
 * commands -- which a worker has no access to at all; only syscalls).
 *
 * This is deliberately as close to real `pwd` as a syscall-only program can get: it calls
 * `getcwd()` (a real syscall, not a value read off a JS object) and writes the result to fd 1 with
 * `write()` (a real syscall too), so redirected/piped stdout is exercised for real, not simulated.
 *
 * Deliberately has NO import of `@zenfs/linux/uapi/*` itself -- a second, separately bundled copy
 * of those modules would have its own private, never-resolved `ready` (confirmed by hand: it hangs
 * forever), since only the module instance that actually received the real `init` message --
 * `/bin/node.mjs` itself, the real Worker entrypoint -- has a working syscall channel. `/bin/node`
 * exposes its own already-initialized wrappers on `globalThis.ecmaosSyscalls` for exactly this
 * reason; see its own doc comment.
 *
 * Bundled the same way `/bin/node`/`/bin/wali` are (see `vite-plugin-bin-node.ts`) even though it
 * has no imports left to inline -- kept consistent with how every other worker-hosted program in
 * this codebase ships, not because bundling does anything for this particular file.
 */

const { getcwd, write, exit } = globalThis.ecmaosSyscalls

try {
  const cwd = getcwd()
  write(1, new TextEncoder().encode(cwd + '\n'))
  exit(0)
} catch (error) {
  write(2, new TextEncoder().encode(`pilot-pwd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
