export const TestDomOptions = { topbar: false }
export const TestLogOptions = undefined

/** The kernel option for a test that runs a prebuilt WebAssembly program: every program, where the default catalog is empty (see `tests/setup.ts`) */
export const PROGRAMS_ALL = '/programs/index.json?all'

/** The permissive programs only: a test that needs ps and sleep but expects /bin/bash to be the shell's link, not the copyleft bash */
export const PROGRAMS_COREUTILS = '/programs/index.json?coreutils'
