// SPDX-License-Identifier: MIT OR Apache-2.0
// The host calls libecmaos makes (ecmaos/imports.h), declared for Emscripten's link so they stay imports: ecmaOS runs
// the .wasm on its own host (core/kernel/src/bin/wasi-preview1.mjs) and never this JavaScript. Each answers ENOSYS.
const ENOSYS = 52
addToLibrary({
  __ecmaos_spawn: () => -ENOSYS,
  __ecmaos_execve: () => -ENOSYS,
  __ecmaos_wait4: () => -ENOSYS,
  __ecmaos_kill: () => -ENOSYS,
  __ecmaos_sigstate: () => 0,
  __ecmaos_set_sigstate: () => 0,
  __ecmaos_sleep: () => -ENOSYS,
  __ecmaos_pause: () => -ENOSYS,
  __syscall_getpid: () => 42,
  __syscall_getppid: () => 1,
  __syscall_getpgid: () => 42,
  __syscall_setpgid: () => -ENOSYS,
  __syscall_getsid: () => 42,
  __syscall_setsid: () => -ENOSYS,
})
