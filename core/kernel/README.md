# The Web OS

[![Launch ecmaOS.sh](https://img.shields.io/badge/launch-ecmaos.sh-blue?style=for-the-badge)](https://ecmaos.sh)

> Made with ❤️ by [Jay Mathis](https://jaymath.is)
>
> [![Stars](https://img.shields.io/github/stars/mathiscode?style=flat&logo=github&label=⭐️)](https://github.com/mathiscode) [![Followers](https://img.shields.io/github/followers/mathiscode?style=flat&logo=github&label=follow)](https://github.com/mathiscode)

[ecmaOS](https://ecmaos.sh) is a browser-based operating system kernel and suite of applications written primarily in TypeScript, Rust, and C++. It's the successor of [web3os](https://github.com/web3os-org/kernel).

The goal is to create a kernel and supporting apps that tie together modern web technologies and utilities to form an "operating system" that can run on modern browsers, not just to create a "desktop experience". It offers the ability to run a wide variety of apps on top of an already (mostly) sandboxed foundation, offering some measure of security by default as well as rich developer tooling. Its main use case is to provide a consistent environment for running web apps, but it has features that allow for more powerful custom scenarios, such as a platform for custom applications, games, and more.

This is NOT intended to be a "Linux kernel in Javascript" - while it takes its heaviest inspiration from Linux, it is more experimental and follows different design principles and architecture, and also doesn't need to cover nearly the same scope.

---

> *"The computer can be used as a tool to liberate and protect people, rather than to control them."*
> — Hal Finney

[![Version](https://img.shields.io/github/package-json/v/ecmaos/ecmaos?color=success)](https://www.npmjs.com/package/@ecmaos/kernel)
[![Site Status](https://img.shields.io/website?url=https%3A%2F%2Fecmaos.sh)](https://ecmaos.sh)
[![Created](https://img.shields.io/github/created-at/ecmaos/ecmaos?style=flat&label=created&color=success)](https://github.com/ecmaos/ecmaos/pulse)
[![Last Commit](https://img.shields.io/github/last-commit/ecmaos/ecmaos.svg)](https://github.com/ecmaos/ecmaos/commit/main)
[![API Reference](https://img.shields.io/badge/API-Reference-success)](https://docs.ecmaos.sh)
[![GitHub license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-success)](https://github.com/ecmaos/ecmaos/blob/main/LICENSE)

[![Open issues](https://img.shields.io/github/issues/ecmaos/ecmaos.svg?logo=github)](https://github.com/ecmaos/ecmaos/issues)
[![Closed issues](https://img.shields.io/github/issues-closed/ecmaos/ecmaos.svg?logo=github)](https://github.com/ecmaos/ecmaos/issues?q=is%3Aissue+is%3Aclosed)
[![Open PRs](https://img.shields.io/github/issues-pr-raw/ecmaos/ecmaos.svg?logo=github&label=PRs)](https://github.com/ecmaos/ecmaos/pulls)
[![Closed PRs](https://img.shields.io/github/issues-pr-closed/ecmaos/ecmaos.svg?logo=github&label=PRs)](https://github.com/ecmaos/ecmaos/pulls?q=is%3Apr+is%3Aclosed)

[![Star on GitHub](https://img.shields.io/github/stars/ecmaos/ecmaos?style=flat&logo=github&label=⭐️%20stars)](https://github.com/ecmaos/ecmaos/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/ecmaos/ecmaos?style=flat&logo=github&label=🔀%20forks)](https://github.com/ecmaos/ecmaos/forks)
[![GitHub watchers](https://img.shields.io/github/watchers/ecmaos/ecmaos?style=flat&logo=github&label=👀%20watchers)](https://github.com/ecmaos/ecmaos/watchers)
[![Sponsors](https://img.shields.io/github/sponsors/mathiscode?color=red&logo=github&label=💖%20sponsors)](https://github.com/sponsors/mathiscode)
[![Contributors](https://img.shields.io/github/contributors/ecmaos/ecmaos?color=yellow&logo=github&label=👥%20contributors)](https://github.com/ecmaos/ecmaos/graphs/contributors)

[![Discord](https://img.shields.io/discord/1311804229127508081?label=discord&logo=discord&logoColor=white)](https://discord.gg/ZJYGkbVsCh)
[![Matrix](https://img.shields.io/matrix/ecmaos:matrix.org.svg?label=%23ecmaos%3Amatrix.org&logo=matrix&logoColor=white)](https://matrix.to/#/#ecmaos:matrix.org)
[![Bluesky](https://img.shields.io/badge/follow-on%20Bluesky-blue?logo=bluesky&logoColor=white)](https://bsky.app/profile/ecmaos.sh)
[![Reddit](https://img.shields.io/reddit/subreddit-subscribers/ecmaos?style=flat&logo=reddit&logoColor=white&label=r/ecmaos)](https://www.reddit.com/r/ecmaos)

## Features

- TypeScript, WebAssembly, Rust, C++
- Filesystem supporting multiple backends powered by [zenfs](https://github.com/zen-fs/core)
- Terminal interface powered by [xterm.js](https://xtermjs.org)
- Streams for handling input and output, allowing redirection and piping
- Device framework with a common interface for working with hardware: **WebBluetooth, WebSerial, WebHID, WebUSB, etc.**
- Some devices have a builtin CLI, so you can run them like normal commands: `# /dev/bluetooth`
- WebAssembly binaries are the native executable format; `# ./hello.wasm --world`
- Many common files can be viewed directly: `# ./image.jpg`, `# ./doc.pdf`
- Install any client-side npm package; `# install axios`
- Event manager for dispatching and subscribing to events
- Real worker-hosted `execve` processes (real pids, signals, and exit codes) for running commands, apps, and daemons
- Interval manager for scheduling recurring operations with support for cron expressions via the `cron` command
- Memory manager for managing pseudo-memory: Collections, Config, Heap, and Stack
- Storage manager for managing Storage API capabilities: IndexedDB, localStorage, etc.
- User manager for managing users and authentication (all client-side, so limited real security but useful for organizational purposes)
- Internationalization framework for translating text powered by [i18next](https://www.i18next.com)
- Window server (`kernel.windows`) that keeps window state - owner, geometry, state, focus order - and hands drawing to a renderer; in the browser, [WinBox](https://github.com/nextapps-de/winbox) draws the windows. A host with no renderer cannot open windows (`ENODEV`), and a process may have at most 32 open (`kernel.windows.maxPerProcess`)
- A desktop (`startx`), Linux framebuffers (`/dev/fb<N>`) and evdev input (`/dev/input/event<N>`), a Wayland compositor (`wlcomp`), and SDL 3 with OpenGL ES for WebAssembly programs; see [Desktop and graphics](#desktop-and-graphics)
<!-- - `BIOS`: A C++ module compiled to WebAssembly with [Emscripten](https://emscripten.org) providing performance-critical functionality -->
<!-- - `Jaffa`: A [Tauri](https://tauri.app) app for running ecmaOS in a desktop or mobile environment -->
- `Node`: ecmaOS in a Node process, which other ecmaOS machines can log in to with a key (`ecmaos --listen`)
- `Peer`: the wire protocol ecmaOS machines speak to each other: a binary codec and multiplexed channels with flow control
- `SWAPI`: An API server running completely inside a service worker using [Hono](https://hono.dev)

## Basic Concepts

### Apps

> [/apps](/apps)

- These are full applications that are developed specifically to work with ecmaOS
- Refer to the full list of [official published apps on npm](https://www.npmjs.com/org/ecmaos-apps)
- See the [APPS.md](/APPS.md) file for a list of community apps; submit a PR to add your app!
- An app is an npm package, in which the bin file has a shebang line of `#!ecmaos:bin:app:myappname`
- Its default export (or exported `main` function) will be called with the `ProcessEntryParams` object
- They can be installed from the terminal using the `install` command, e.g. `# install @ecmaos-apps/code`
- Run the installed app (bins are linked to `/usr/bin`): `# code /root/hello.js`
- During development, it can be useful to run a [Verdaccio](https://github.com/verdaccio/verdaccio) server to test local packages
- To publish to Verdaccio, run `# npm publish --registry http://localhost:4873` in your app's development environment
- Then to install from your local registry, run (inside ecmaOS) `# install @myscope/mypackage --registry http://localhost:4873`

### Execution Model

> [/core/kernel/src/tree/kernel.ts](/core/kernel/src/tree/kernel.ts) · [/core/kernel/src/bin](/core/kernel/src/bin)

Every runnable file in ecmaOS - a coreutil, a kernel command, an app, a WASM binary - is dispatched the same way: `Kernel.execute` reads the file's header (a shebang or magic bytes) and routes it to a real, worker-hosted `execve` process (from `@zenfs/linux`'s process/thread model), not to a hand-rolled in-process class. That process has a real pid, real signals, and a real exit code, and can be `kill`ed, waited on (`proc_wait`), and listed (`ps`) like any other process.

- **`/bin/node`** ([/core/kernel/src/bin/node.mjs](/core/kernel/src/bin/node.mjs)) runs any plain JavaScript program (`#!ecmaos:bin:node`, or a coreutil with no shebang) inside the worker, with a small `globalThis.ecmaosSyscalls` bridge to the real syscall table. This is how every `@ecmaos/coreutils` command runs - `cat`, `ls`, `grep`, `free`, and the rest are just JS files executed this way, not special-cased kernel code.
- **npm packages run.** A program that `require`s or `import`s files, packages or Node's own modules (CommonJS, or an ES module; any `#!/usr/bin/env node` command) is run by `/bin/node`'s loader ([/core/kernel/src/bin/loader](/core/kernel/src/bin/loader)) instead of being imported whole. It resolves as Node does: `node_modules` walked up from the real file (`install` links each package's dependencies into its `node_modules`, so a package finds the versions it was installed with), `exports` and `imports` maps with their conditions, `main` and `index`, and, for a package installed before `node_modules` was laid out, the highest version in `/usr/lib` or `~/.local/lib`. Each module runs once, in a registry keyed by its real path, so a cycle sees the exports so far. An ES module is converted with `sucrase` (live bindings, top-level `await`, `import.meta`, `import()`), loaded only when a program has one to run. The program stays alive until its timers, children, requests and reads are done, and ends with `process.exitCode`, as Node's does. The Node modules are CommonJS files in `/usr/lib/node/builtins`, bundled at build time (`src/bin/node-builtins`) and written at boot behind one stamp: `process`, `fs` (and `fs/promises`, streams), `path`, `events`, `buffer`, `util` (with `parseArgs`), `url`, `os`, `stream`, `child_process` (`spawn`, `exec`, the `*Sync` forms, piped stdio over `proc_spawn`), `readline`, `timers`, `crypto`, `zlib`, `assert`, `vm`, `http` and `https` clients over `fetch`, `module`, `tty`, `string_decoder`, `querystring`, `punycode`, `perf_hooks`, `async_hooks`, `worker_threads` (the main thread only), `v8`, `inspector`, `diagnostics_channel`, `dns`, and stubs that load and say they are unavailable when used for `net`, `tls`, `dgram`, `http2` and `cluster` (and `http.createServer`). A program with nothing to resolve (a bundle, even one with top-level `await`) is imported as it always was.
- **`/bin/wali`** ([/core/kernel/src/bin/wali.mjs](/core/kernel/src/bin/wali.mjs)) runs WALI-format WebAssembly modules - musl compiled to call `@zenfs/linux`'s real kernel syscalls (`SYS_open`, `SYS_read`, ...) directly, not through a WASI ABI. WALI and WASI Preview 1 are different, incompatible module formats. `utils/check-wali.sh` builds and pins the toolchain for them: WALI's musl with ecmaOS's patches (`utils/wali/patches`), the Linux UAPI headers (`linux/*.h`), compiler-rt, and libc++, libc++abi and libunwind, with C++ exceptions and `setjmp`/`longjmp` on WebAssembly exception handling. Such a program is Linux to itself (Linux `errno` values and structures, a real `syscall()`), and returning from `main` flushes its output and runs its `atexit` handlers; an exception it does not catch ends it by `SIGABRT`. ecmaOS adds to the dependency's host what it lacks ([/core/kernel/src/bin/wali-host.mjs](/core/kernel/src/bin/wali-host.mjs)): the `*at` calls against a directory descriptor, `fcntl` descriptor flags, `getdents64` that reaches the end, `mmap` that reuses freed ranges and fills private file mappings, shared mappings of files and devices (a framebuffer) kept in step with them at calls, as the Emscripten programs' are, `memfd_create` (a file in `/dev/shm`, unlinked as it is made) and `fallocate` (which grows a file), and the input, framebuffer and GL devices' ioctls. Processes and signals are POSIX's: `posix_spawn` (and `system` and `popen` on it) starts a child with a copy of the caller's descriptors, close-on-exec flags and file actions applied as a forked child would, `waitpid` and `execve` work, the ignored signals and the mask carry into a child and across an exec, and a handler runs when the call the program is in returns, with `EINTR` or a restart (`SA_RESTART`) for a call it interrupted; `sleep`, `pause`, `sigsuspend`, `sigprocmask` and `raise` behave as on Linux, and a write nothing will read raises `SIGPIPE`. Job control is Linux's: a stopped process stays stopped until `SIGCONT` (which continues it whether or not it catches it), a `WUNTRACED` wait reports the signal that stopped it, and a process reading its controlling terminal from the background gets `SIGTTIN` (EIO when it ignores or blocks it), with `SIGTTOU` for changing the terminal's settings or writing with `TOSTOP`; ptys (`posix_openpt`, `ptsname`, `TIOCSWINSZ`, and `TIOCPKT` packet mode with its data byte) work, and a process sets its user and group ids with `setuid`, `setreuid`, `setresuid` and the group calls, by Linux's rules (root sets any; another user only to an id it holds), with `getresuid`, `getgroups` and `setgroups`. There is no `fork`. Threads are POSIX threads: each runs in a worker of its own on the program's one shared memory, with the process's descriptors, working directory, credentials, allocator and signal dispositions (its signal mask is its own), futexes on `Atomics`, and `exit()` or a fault in any thread ending the process. Stream sockets are files: one descriptor the kernel reads, writes and polls, which a child can inherit, for `socketpair`, `AF_UNIX` (a socket bound to a path is a socket file there too, which `stat` and `ls` show as `s`, that `chmod` and `unlink` change, and that a path already in use refuses with `EADDRINUSE`; closing it leaves the file, as on Linux), and `AF_INET`/`AF_INET6` on loopback or through the gateway, with `epoll`, `MSG_PEEK`, `MSG_DONTWAIT` and `O_NONBLOCK` (which `fcntl` now sets on the open file, so it also holds for pipes); a connection still talks to an Emscripten program or `node` holding it as a pair of pipes. Datagram sockets (UDP, `sendmsg`/`recvmsg`) work, and a local socket passes descriptors (`SCM_RIGHTS`) and says who is at the other end (`SO_PEERCRED`). The programs ecmaOS ships are built this way (`wasm/<name>/build.sh` in `core/utils` or `core/utils-copyleft`): the Wayland compositor `wlcomp`, `doom` (doomgeneric in a window, on SDL 3's Wayland driver, with libwayland and libxkbcommon built the same way), the desktop demos (`wldemo` on libwayland-client; `sdlsnake`, `sdlpaint`, `sdlclip`, `sdlpad`, `sdlgl` and `sdlgears` on SDL 3), `vim` (and `vi`; Vim 9.1 with a subset of its runtime: syntax highlighting and filetype detection for common languages, no `:help`), `sqlite3` (the SQLite shell, with linenoise history), `jq`, `lua` (Lua 5.4), `qjs` (QuickJS, with `os.exec` and `os.Worker`), `bc` (and `dc`, a link to it), `tree`, `make` (GNU make, with `-j`), `nano` (with ncurses), `htop` (with ncurses, reading `/proc`), `perl` (Perl 5.44 with the core modules linked in; it forks, so it is built with Asyncify: `system`, backticks and pipe opens work), `screen` (GNU screen, with ncurses; it forks, so it is built with Asyncify: windows, detach and reattach, `-X`, and a board's serial console with `screen /dev/ttyACM0 115200`), `aplay`, `arecord`, `amixer` and `speaker-test` (ALSA's tools on alsa-lib, which reach the browser's speakers and microphone through `/dev/snd` as they reach a card on Linux), `bzip2`, `xz`, `zstd` and `lz4` (with `unlz4` and `lz4cat`; the last three compress on threads with `-T`), `brotli`, `ed`, `mandoc`, `ncdu`, `mg`, `patch` (toybox) and `micropython` (MicroPython 1.29, also `python` and `python3`, with asyncio, threads (`_thread`) and a set of micropython-lib modules frozen in; its garbage collector scans the C stack, so the build has Binaryen spill wasm locals to it, see `core/utils/wasm/micropython/build.sh`). Where a program forks to run a command (Vim's `:!` and filters, nano's `^T`, ncdu's `b`, mg's shell commands, make's recipes), it starts it with `posix_spawn`. Every other WebAssembly program runs as a worker process under `/bin/wali` too; see [Running other WebAssembly](#running-other-webassembly).
- **The package managers people type.** `apt`, `apt-get`, `apt-cache`, `dpkg`, `pacman`, `npm`, `npx`, `yarn` and `pnpm` are front-ends of `install` ([/core/kernel/src/bin/commands/lib/install](/core/kernel/src/bin/commands/lib/install)): the same engine, database, cache and signature checks under each tool's own commands, flags and output. The distribution tools take their own package names; `@ecmaos/package-index` ([/utils/package-index](/utils/package-index), an npm package with a copy built in, refreshed by `apt update` / `pacman -Sy`) maps each to the npm package that provides it, says which names ecmaOS ships already, and a name it does not know is refused with the npm packages that look close, never guessed at. `npm`, `yarn` and `pnpm` install into the project: `node_modules/NAME` linked to `node_modules/.ecmaos/NAME/VERSION` (each with its own `node_modules`), bins in `node_modules/.bin`, `package.json` kept up to date, scripts run with `node_modules/.bin` on the `PATH`; `-g` is `install`'s scope (`/usr` for root, `~/.local` for anyone else); `npx` and `dlx` fetch a package into the cache and run its bin. There is no lockfile. `pip` / `pip3` install from PyPI ([/core/kernel/src/bin/commands/lib/pip](/core/kernel/src/bin/commands/lib/pip)): the JSON API, PEP 440 versions and PEP 508 requirements with their markers evaluated for this machine, pure-Python wheels checked against PyPI's SHA-256 and unpacked into CPython's `site-packages` (the system's as root, `~/.local` otherwise) with the `dist-info` records Python's own tools read (pip keeps no database of its own); a project with only native wheels or source distributions is refused with the reason. The programs are grouped as meta-packages (`@ecmaos-apps/group-*`, and the profiles `profile-*` of groups), a package can recommend, suggest, conflict with, replace or require a kernel (`"ecmaos": { "requires": ... }`), `install hold` and `install rollback` pin and undo a version, `/etc/ecmaos/sources.d` maps scopes to registries, and `@ecmaos-apps` is checked against an Ed25519-signed index (`--allow-unsigned` for a registry of your own). A machine keeps one of four **profiles** (`minimal`, `standard`, `developer`, `everything`, in `/etc/ecmaos/profile`) of those programs: a browser's first boot asks once on the terminal (Standard after 15 seconds, with what each downloads), Node, scripts and tests get Standard (`KernelOptions.profile`, `?profile=` and `ECMAOS_PROFILE` pick one), and a machine that already had programs becomes Everything and loses none. The boot records what it installed in the install database (each program a `seeded` entry, then groups and the profile), so `apt`, `pacman` and `install` see it; installing a program's package replaces the catalog's copy in `/bin`, and `profile set NAME` changes the profile, showing what a smaller one removes first.
- **Emscripten programs** run under `/bin/wali` too. `core/kernel/src/bin/emscripten.mjs` (loaded on demand next to `wasip1.mjs`) translates an ordinary (non-standalone) emcc build's `env.__syscall_*` and `wasi_snapshot_preview1` imports onto the real syscalls, so a C program built with `emcc` runs as a worker process with a pid, signals and a controlling terminal. None of the programs ecmaOS ships is built this way now; the shim answers `system()`, `strptime`, `gmtime`/`timegm`, `readdir` and advisory file locks for such a program (locks are always granted). libecmaos (`core/utils/wasm/lib/ecmaos.sh`) is what ecmaOS adds to Emscripten's libc so such a program has processes and signals as a WALI one does: `posix_spawn` (the same host call, [/core/kernel/src/bin/spawn.mjs](/core/kernel/src/bin/spawn.mjs)), `execve`, `waitpid`, `kill`, `system` and `popen`, its real pid, the kernel's signals run through its handlers, `alarm` and `setitimer`, and sleeps a signal ends; none of the programs shipped now needs it. The binaries are not part of the kernel bundle, whichever way they are built: each is committed in the package that owns it (`core/utils-copyleft/programs/` for the copyleft ones, `core/utils/programs/` for the permissively licensed ones, each with a `manifest.json`), the site serves them under `/programs/` with a catalog, and boot writes a program into `/bin` only when the installed copy differs from the catalog's.
- **`/bin/app`** ([/core/kernel/src/tree/lib/presenters/app.ts](/core/kernel/src/tree/lib/presenters/app.ts)) is the presenter for programs that must touch the DOM - `#!ecmaos:bin:app:<name>` (a windowed app like `code` or `webamp`) and `#!ecmaos:bin:program:<name>` (an `@ecmaos-apps/*` package that isn't windowed but still needs `document`, i18n, or other main-thread state). The real process is still a worker with a pid and signals; the app's own `main(params)` runs on the main thread, where it has the live `kernel`/`shell`/`terminal` the DOM-app ABI has always given it, and the process's lifetime is tied to `main`'s return (or the window closing) via a small dispose/keepAlive shim, not a bespoke lifecycle class.
- **Main-thread custom syscalls.** A worker can't reach the DOM, WebAuthn, or the kernel's own singletons directly - only the main thread can. `core/kernel/src/tree/lib/main-thread-syscalls.ts` uses `@zenfs/linux`'s public `define_syscall` to register ecmaOS-specific syscalls (`window_create`, `window_write`, `window_close`, `window_list`, `window_focus`, `window_move`, `window_resize`, `window_set_title`, `storage_usage`, `users_lookup`, `klog`, `proc_spawn`, `proc_wait`, and more) that a worker-hosted process can call like any other syscall; the handler runs on the main thread and the result crosses back over the same `Atomics.wait`-blocking syscall ABI `@zenfs/linux` uses for its own syscalls. This is how a worker-hosted coreutil or kernel command reaches main-thread-only capability without itself running on the main thread.
- **The manifest `syscalls`/`devices` allowlist.** A program at `/path/to/program` may ship a sibling `/path/to/program.manifest.json`: `{ "syscalls": ["read", "write", "openat"], "devices": ["tty", "echo"] }`. When present, `core/kernel/src/tree/lib/syscall-policy.ts` refuses any syscall the manifest doesn't list with `-EPERM` before the real handler runs, and `Kernel.registerDevices()`'s per-major device dispatch enforces `devices` the same way at the point a device node is opened. A program with no manifest is unrestricted (today's default), so the allowlist is opt-in per-program rather than mandatory.

### Running other WebAssembly

> [/core/kernel/src/bin/wali.mjs](/core/kernel/src/bin/wali.mjs) · [/core/kernel/src/bin/wasip1.mjs](/core/kernel/src/bin/wasip1.mjs) · [/core/kernel/src/bin/wasip2.mjs](/core/kernel/src/bin/wasip2.mjs) · [/core/kernel/src/bin/emscripten.mjs](/core/kernel/src/bin/emscripten.mjs)

Every WebAssembly program is a worker process with a pid, signals, a controlling terminal and an exit status, whatever it was built for; there is no main-thread host. `/bin/wali` reads the module's imports and picks the ABI:

| Built for | Recognized by | Build it with | Notes |
| --- | --- | --- | --- |
| WALI (preferred) | imports from `wali` | WALI's musl, `utils/check-wali.sh` | Linux to itself: real `errno`s, threads, sockets, `posix_spawn`, job control |
| WASI Preview 1 | imports `wasi_snapshot_preview1` | `wasm32-wasip1` (Rust, wasi-sdk, Go's `GOOS=wasip1`) | `_start` or a reactor's `_initialize`; preopens are `/`, `.` and each top-level directory; sockets, `poll_oneoff` and `proc_exit` work, `fork` and threads do not |
| WASI Preview 2 | a component (`\0asm` with the component layer) | `wasm32-wasip2` (Rust), `wasm-tools component new`, `jco componentize` | Transpiled by the kernel with jco, run on a `wasi:*` 0.2 host; see [Known gaps](#known-gaps) |
| Emscripten | imports `env.__syscall_*` | `emcc` (not `STANDALONE_WASM`) | A compatibility layer for existing builds; ecmaOS ships none; libecmaos adds processes and signals |

What does not work: a module that exports none of `_start`, `_initialize` or `main` is a library and is refused with a message; a module that imports something the host lacks fails to start and names it; `fork` (use `posix_spawn`), WASI 0.3, `wasi:http` and `wasi-threads` are not provided.

Run one by path (`./hello.wasm`) or put it in `/bin`; `man wasm` has the details.

### Commands

> [/core/kernel/src/bin/commands](/core/kernel/src/bin/commands)

- `Commands` are the kernel's own programs, e.g. `download`, `install`, `load`, `mount`, `passwd`. Each is a real `execve`'d program that reaches main-thread-only capabilities (DOM, WebAuthn, the kernel's singletons) through custom syscalls and presenters, same as any other program in the execution model above.

### Coreutils

> [/core/utils](/core/utils)

- `Coreutils` are similar to `Commands`, but are provided by the `@ecmaos/coreutils` package, e.g. `cat`, `chmod`, `cp`, `echo`, `git`, `ls`, `mkdir`, `mv`, `pwd`, `rm`, `rmdir`, `stat`, `touch`, etc. They run under `/bin/node` in the execution model above, using plain filesystem/process syscalls - no kernel-singleton access, and no shell-state mutation (a coreutil can't change its own shell's cwd or env; that's what the shell builtins are for).

### Devices

> [/devices](/devices)

- Refer to the full list of [official devices on npm](https://www.npmjs.com/org/ecmaos-devices)
- See the [DEVICES.md](/DEVICES.md) file for a list of community devices; submit a PR to add your device!
- Devices get loaded on boot, e.g. `/dev/bluetooth`, `/dev/random`, `/dev/battery`, etc.
- A device can support being "run" by a user, e.g. `# /dev/battery status`
- Devices may also be directly read/written using `fs` methods, and will behave accordingly (or have no effect if not supported)
- An individual device module can provide multiple device drivers, e.g. `/dev/usb` provides `/dev/usb0`, `/dev/usb1` and so on, one per granted device (see [Device Examples](#device-examples))

### Desktop and graphics

> [/apps/desktop](/apps/desktop) · [/core/kernel/src/tree/lib/fb.ts](/core/kernel/src/tree/lib/fb.ts) · [/core/utils/wasm](/core/utils/wasm)

- **Desktop.** `startx` (`install @ecmaos-apps/desktop`; the dev server links it) starts a desktop over the console: a taskbar, a launcher for the `.desktop` entries in `/usr/share/applications` (`install` links the ones a package ships), a window list, terminal windows (a login shell on a pty each), a Login window, workspaces (Ctrl+Alt+1 to 9) and a wallpaper, kept in `~/.config/ecmaos/desktop.json`. Ctrl+Alt+F1 to F8, or Exit, returns to the console. `wmctrl` lists, moves, switches and closes windows from the shell.
- **Framebuffers.** `fbwin` opens a window with a Linux framebuffer device, `/dev/fb<N>` (major 29, up to 32): write `xrgb8888` pixels to it, or `mmap` it `MAP_SHARED` from a WebAssembly program. `FBIOGET_VSCREENINFO` and `FBIOGET_FSCREENINFO` describe it, `FBIO_WAITFORVSYNC` waits for the next painted frame, and `fbwin -r` makes a screen that follows the window's size.
- **Input.** `/dev/input/event0` (keyboard) and `event1` (pointer) are evdev nodes fed from the page, with `input_event` records, `poll` and the `EVIOCG*` ioctls; each framebuffer window adds one of its own (`event<2+N>`) for the input it receives. Each gamepad the browser shows (once a button has been pressed on it) is `event<N>` from `event34` up and `/dev/input/js<N>`, with Linux's gamepad codes (`BTN_SOUTH` and the rest, sticks and analog triggers as `ABS_*` axes, the d-pad as a hat), `EV_FF` rumble, the joystick API's `JSIOC*` ioctls and names under `/dev/input/by-id`; it goes when the pad does, and a program that still has it open gets `ENODEV`. `evtest` shows any of them.
- **Wayland.** `wlcomp &` is a Wayland compositor: `wl_compositor`, `wl_shm`, xdg-shell toplevels, `wl_seat` (pointer and keyboard), cursor shapes and images, maximize, fullscreen and minimize, and a clipboard shared with the browser. Each toplevel is a framebuffer window. libwayland-client and libxkbcommon are built for WebAssembly programs (`core/utils/wasm/lib`).
- **SDL 3 and OpenGL ES.** SDL 3 runs on its Wayland driver, with audio to `/dev/dsp1`, joysticks through its own Linux driver on `/dev/input/event<N>`, and OpenGL ES 2 through `/dev/gl<N>` (major 227), a context each drawn by the browser's WebGL2. The demos are `wldemo`, `sdlsnake`, `sdlpaint`, `sdlclip`, `sdlpad`, `sdlgl` and `sdlgears`, and `doom` (`@ecmaos/coreutils-copyleft`; bring your own WAD, Freedoom works) runs on the same stack. Each has a man page.
- **Other screens.** In the Node host (`ecmaos`), windows open as host windows through a loopback display server (the system web view when `@webviewjs/webview` is installed), and apps with a display entry (`code`, `webamp`) run in a sandboxed frame there. A browser page at `?screen=HOST` is a screen of a machine started with `ecmaos --listen`: it logs in with a key of its own and draws that machine's windows.

### Filesystems

> [/core/kernel/src/bin/commands/mount.mjs](/core/kernel/src/bin/commands/mount.mjs)

ecmaOS supports multiple filesystem backends powered by [zenfs](https://zenfs.dev), allowing you to mount various storage types into the virtual filesystem.

#### One tab per machine

> [/core/kernel/src/tree/lib/machine-lock.ts](/core/kernel/src/tree/lib/machine-lock.ts)

The root filesystem is an IndexedDB store that each tab loads whole into its own memory, and new files take their ids from that copy, so two tabs on one store would overwrite each other's files. The kernel therefore holds a Web Lock named for the store (`ecmaos:machine:zenfs`) for as long as it runs, taken before the store is loaded. A second tab on the same origin shows "This machine is running in another tab" and starts by itself when the first closes, crashes or halts; "Use it here instead" takes the machine over, and the first tab then stops (its writes are fenced off, its programs killed) and offers "Take it back", which reloads it with what the other tab saved. `reboot`, `halt` and `poweroff` wait for pending writes to reach IndexedDB first. There is no guard for a host without Web Locks (the Node host, tests) or a root that is not the default IndexedDB store. **Guest session.** The notice's third button runs a scratch machine in that tab: the root is in memory, the stamps that say what is installed are throwaway keys (removed when the tab goes), nothing is saved, `format` refuses (it would otherwise wipe the other tab's machine), and a badge in the corner says so. Closing the tab ends it; the other tab is untouched. **`fsck`** reads the whole root and reports what two tabs sharing one store leave behind (one inode number used by unrelated files, a directory reached twice, with `--read` a file shorter or longer than its inode says); it changes nothing. A `pagehide` flush is not provided: writes are issued as the program makes them, so a closing page has nothing buffered to flush, and a page cannot wait for IndexedDB while it unloads.

**Consoles in other tabs.** The notice's "Open a console on it" button, or the address `?display=N` (N is 0 to 7, with `&machine=NAME` for another machine), turns a second tab into a display of one of the running machine's terminals: no kernel or filesystem runs in it. The tab that owns the machine mirrors that terminal's output over a `BroadcastChannel` and takes the keys, the window size and the tab's presence (a Web Lock the display holds) back, so login, shells and programs behave as at its own screen. A tty with several displays is as big as the smallest. Browser calls that need the page the user is at (`xclip`, `notify-send`, `say`, `open` of a URL or a file to download, `upload`) are done by the display the user last typed at, since the owner's tab may be in the background (the owner reads the file for a download and writes what `upload` picked, so the display needs no filesystem). A display notices when the machine goes away (the owner reloaded, closed or halted) and attaches again, from a fresh screen, when one answers. It is an experiment: the session token travels on a channel any page of the origin can read, which is no boundary since such a page can read the machine's IndexedDB root anyway; Ctrl+Shift+N in a display attaches it to that tty (the tab reloads onto it); `video` and `audio` play in a full-page overlay of the display (the owner sends the file); a program that opens a window with the machine's own window manager (`edit`, `web`) still opens it in the owner's tab.

**Several machines on one origin.** `?machine=NAME` (lowercase letters, digits and dashes, up to 32) runs a separate machine with its own files in the IndexedDB store `zenfs-NAME`, with its own lock, so it runs beside the default machine in another tab. No parameter, or `?machine=root`, is the default machine (the store `zenfs`, as ever). The few `localStorage` keys that describe a store (what was installed into it, first boot) are kept per machine, and `format` wipes only the machine it runs on. The "another tab" notice offers to open a new machine. Machines cannot see each other's files; `mount` or `attach` over `--listen` is how they would share.

#### Supported Filesystem Types

- **memory**: In-memory filesystem (temporary, lost on page reload)
- **indexeddb**: IndexedDB-backed persistent filesystem
- **webstorage**: WebStorage-backed filesystem (localStorage or sessionStorage)
- **webaccess**: File System Access API filesystem (requires user interaction)
- **singlebuffer**: Filesystem backed by a single buffer
- **fetch**: Remote filesystem via HTTP fetch
- **xml**: DOM XML filesystem (WIP)
- **zip**: Read-only filesystem from a zip archive (file or URL)
- **iso**: Read-only filesystem from an ISO image (file or URL)
- **tar**: Read-only filesystem from a tar archive, gzipped or not (file or URL)

With a source and no `-t`, an image's type is found from its first bytes (or a URL's name), so `mount -o loop disk.iso /mnt/iso` works as on Linux.
- **dropbox**: Dropbox filesystem (WIP)
- **s3**: S3 filesystem (WIP)
- **googledrive**: Google Drive filesystem (WIP)

#### Basic Usage

```sh
# Mount a memory filesystem
mount -t memory /mnt/tmp

# Mount an IndexedDB store
mount -t indexeddb mydb /mnt/db

# Mount WebStorage (localStorage by default)
mount -t webstorage /mnt/storage

# Mount WebStorage using sessionStorage
mount -t webstorage /mnt/storage -o storage=sessionStorage

# Mount a zip archive
mount -t zip /tmp/archive.zip /mnt/zip

# Mount from a remote URL
mount -t zip https://example.com/archive.zip /mnt/zip

# Mount an image, its type found from its contents
mount -o loop /tmp/site.tar.gz /mnt/site

# Mount a fetch filesystem (see utils/fetch-fs-server.js)
mount -t fetch index.json /mnt/api -o baseUrl=http://localhost:30808

# List all mounted filesystems
mount -l

# Unmount a filesystem
umount /mnt/tmp
```

#### /etc/fstab

The kernel automatically processes `/etc/fstab` during boot to mount filesystems. The fstab format is space or tab-separated:

```plaintext
source target type [options]
```

**Format:**

- `source`: Device/URL/database name (use `none` for filesystems that don't require a source)
- `target`: Mount point (absolute path)
- `type`: Filesystem type
- `options`: Optional comma-separated key=value pairs

**Example /etc/fstab:**

```plaintext
# ecmaOS fstab - Filesystem mount table
# Format: source target type [options]

# Memory filesystem for temporary data
none /mnt/tmp memory

# IndexedDB filesystem for persistent storage
mydb /mnt/db indexeddb

# WebStorage filesystem using localStorage
none /mnt/storage webstorage storage=localStorage

# Fetch filesystem from a remote API
index.json /mnt/api fetch baseUrl=http://localhost:30808
```

### Generators

> [/turbo/generators](/turbo/generators)

- Generators are used to scaffold new apps, devices, modules, etc.
- They are located in the `turbo/generators` directory of the repository
- They are used by the `turbo gen` command, e.g. `turbo gen app`, `turbo gen device`, `turbo gen module`, etc.

### Internationalization

> [/core/kernel/src/tree/i18n.ts](/core/kernel/src/tree/i18n.ts)

- Built-in translations are in the [/core/kernel/locales](/core/kernel/locales) directory and compiled into the kernel at build time
- Translations can be defined and loaded from the filesystem at runtime
- Override or add translations in `/usr/share/locales/{lang}/{namespace}.json`
  - e.g. `/usr/share/locales/en/kernel.json`
- System locale can be set from the `/etc/default/locale` file
- User locale can be set from the `LANG` environment variable
- `kernel.i18n.t` is the primary translation function for the kernel
- `kernel.i18n.ns` provides access to translation functions for specific namespaces
  - e.g. `kernel.i18n.ns.common('Hello')`

### Kernel

> [/core/kernel](/core/kernel)

- The kernel ties together the various components of the system into a cohesive whole
  - Authentication (Passwords, Passkeys, Credentials)
  - Components (Web Components/Custom Elements)
  - Coreutils (Built-in commands)
  - Devices (Web Hardware APIs)
  - DOM (DOM Utilities and Interfaces)
  - Events (CustomEvents)
  - Filesystem (ZenFS)
  - Internationalization (i18next)
  - Interval Manager (setInterval and cron scheduling)
  - Log Manager (tslog)
  - Memory Manager (Abstractions)
  - Execution (worker-hosted `execve` processes via `@zenfs/linux`, real pids/signals/exit codes - see [Execution Model](#execution-model))
  - Protocol Handlers (web+ecmaos://...)
  - Service Worker Manager
  - Shell
  - Sockets (loopback POSIX sockets, `AF_UNIX`/`AF_INET`; see [Sockets](#sockets))
  - Storage (IndexedDB, localStorage, sessionStorage, etc.)
  - Telemetry (OpenTelemetry)
  - Terminal (xterm.js)
  - User Manager
  - WASM Loader (WALI and Emscripten programs as processes via `/bin/wali`; WASI Preview 1 mostly complete; WASI Preview 2 (0.2) components as processes too)
  - Web Workers
  - Window server (state) with a WinBox renderer

### Node

> [/core/node](/core/node)

- Runs the same kernel in a Node process, with the terminal on stdin and stdout and the machine kept in a SQLite file
- `ecmaos --listen` lets other ecmaOS machines log in with a key and get a shell; `connect` is the client
- Logins are over [`@ecmaos/peer`](/core/peer); see the package READMEs and `SECURITY.md` for what is and is not protected

### Modules

> [/modules](/modules)

- Refer to the full list of [official modules on npm](https://www.npmjs.com/org/ecmaos-modules)
- See the [MODULES.md](/MODULES.md) file for a list of community modules; submit a PR to add your module!
- A module is one file, `NAME.ko.mjs`, that starts with a comment block of `key=value` lines (`name`, `version`, `license`, `kernel_api`, `depends`, `parm`) and exports `init(ctx)` and an optional `exit()`
- `insmod [-f] FILE [name=value ...]` loads it, `rmmod [-f] NAME` unloads it, `lsmod` (or `/proc/modules`) lists the loaded ones and `modinfo FILE|NAME` shows what a module says about itself without running it (NAME may be a loaded module, or one installed in `/lib/modules` by name or alias); `insmod` and `rmmod` need root
- A loaded module is in `/proc/modules` and `/sys/module/NAME` (with `parameters/`); it taints the kernel (`O` out-of-tree, `E` unsigned, `F` forced), which `/proc/sys/kernel/tainted` shows, and writing 1 to `/proc/sys/kernel/modules_disabled` stops loading and unloading until reboot
- A module reaches the kernel through `ctx` only: `ctx.param`, `ctx.log`, `ctx.export` and `ctx.import` (symbols listed in `/proc/kallsyms`, a user holds its provider), and `ctx.onExit` for what `rmmod` must undo; the [types](./core/types/modules.ts) are the interface
- A JS module runs in the kernel and is not confined: load only what you trust
- `depmod` reads every `NAME.ko.mjs` under `/lib/modules/RELEASE` (`uname -r`) and writes `modules.dep` and `modules.alias`; `modprobe [-nvr] NAME` loads a module, or an `alias` of one, with what it depends on, and `modprobe -r` unloads it and what it needed that nothing else holds; the file name must be the module name
- `/etc/modprobe.d/*.conf` takes `options NAME name=value`, `alias PATTERN NAME`, `blacklist NAME` (stops loading by alias only), `softdep NAME pre: A post: B`, and `install NAME COMMAND` and `remove NAME COMMAND` (`modprobe --ignore-install` skips them); `/etc/modules-load.d/*.conf` lists one module a line to load at boot, and a failure is logged and does not stop the boot
- A module can add files, all removed when it unloads and each in a directory of the kernel's, never over a name that exists (`EEXIST`): `ctx.proc(path, {show, store?})` makes `/proc/PATH`; `ctx.sys(path, {attr: {show, store?}})` makes `/sys/kernel/PATH`; `ctx.debugfs.file(path, {read, write})` and `ctx.debugfs.value(path, 'u32', ref)` (also `u8 u16 u64 x8 x16 x32 x64 bool str`) make files in `/sys/kernel/debug/NAME` (root only); `ctx.configfs.subsystem({name, attributes, make})` makes `/sys/kernel/config/NAME`, where `mkdir` calls `make` and `rmdir` drops the item; `ctx.command(name, source)` writes the program `/usr/bin/NAME`, which never replaces a command already on the PATH
- A `store` that throws is logged (as a warning from the module) and the write still succeeds, because procfs, sysfs and debugfs fail every later close of a file whose write threw; a module that wants a write refused ignores it
- A module can change what the kernel does: `ctx.filesystem({name, backend, source?, config?})` adds a type to `mount -t` and `/proc/filesystems` (`backend` is a ZenFS `Backend`, taken from `ctx.import('zenfs.core')`; the module cannot unload while one is mounted); `ctx.binfmt({name, matches, interpreter})` teaches `execve` a program format, tried after the `#!` and WebAssembly formats and before JavaScript; `ctx.syscall(name, handler)` adds a syscall a program makes with `ecmaosSyscalls.custom`; `ctx.syscallPolicy(fn)` can refuse any syscall with `EPERM` (it can only deny, and one that throws is logged and ignored). Each is undone when the module unloads, and a name that exists fails with `EEXIST`
- `request_module`: `mount -t TYPE` with a type nobody has loads the module with the alias `fs-TYPE`, and running a file the kernel cannot run loads the one with the alias `binfmt-EXTENSION`; `modprobe` does it as root, `modprobe.d` blacklist and options apply, and nothing is asked for once `modules_disabled` is 1
- A module can also be a WebAssembly component, `NAME.ko.wasm`, of the world in `core/kernel/wit/ecmaos-module.wit`: it exports `lifecycle` (`init`, `exit`) and `hooks`, and imports `kernel` (`log`, `proc`, `sys`, `debugfs-file`, `syscall`, `syscall-policy`, `binfmt`, which do what the context's methods do and call back into `hooks` to read, write and answer; parameters arrive as the argument of `init`, and an import never returns text, only an error number, because a guest cannot safely free memory a WASI 0.3 host gives it). It is sandboxed by its imports: the WASI interfaces a toolchain adds get a clock, random bytes and a place to write log lines (stdout and stderr become `dmesg` lines), and the filesystem, the network and HTTP are refused, so a wasm module can do only what its world lets it. `modinfo` prints `kind: wasm`. The file is the component plus a custom section `ecmaos-module` with the modinfo (the `key=value` lines of a JS module's header), made by `node core/kernel/scripts/wasm-module.mjs pack COMPONENT.wasm INFO.json OUT.ko.wasm` (or `build SOURCE.js ...`, which componentizes a JavaScript module with jco; see `core/kernel/examples/wasm-hello`); `sign-module` signs it by appending a last section `ecmaos-module-signature`, and `insmod`, `modinfo`, `depmod` and `modprobe` take it like a JS module
- A WebAssembly module can be written for WASI 0.2 or 0.3 (the kernel tells by the interfaces the component imports). A 0.2 component answers every hook at once. A 0.3 component's exports are all asynchronous under jco, and the kernel's `/proc`, `/sys` and debugfs reads, the syscall policy and the program-format check must answer at once, so a 0.3 module's files are served from the last text its hook returned (filled once `init` is done, refreshed after each read, so a read can be one behind) and a 0.3 module cannot add a syscall policy or a program format (`syscall-policy` and `binfmt` return 38, ENOSYS, and log why). Its syscalls, `init` and `exit` are asynchronous without trouble. `examples/wasm-hello-rust` is a Rust module for 0.3 (`node core/kernel/scripts/build-wasm-rust.mjs core/kernel/examples/wasm-hello-rust OUT.ko.wasm`; it needs `rustup toolchain install nightly-2026-10-25 --profile minimal -t wasm32-wasip3`, which `rust-toolchain.toml` there selects for that directory only, and `wasm-tools` from `ECMAOS_WASM_TOOLS` or the PATH); it is 70 KB where the JavaScript example is 12 MB
- A WebAssembly module of the world `filesystem-module` also exports `filesystem` (`mount`, `stat`, `readdir`, `read`, `write`, `create`, `unlink`, `rmdir`, `rename`, `link`, `get-attributes`, `set-attributes`, `touch`, on paths from the root of the mount; a failure is an error number; `stat` says how many names a file has, and a hard link is a second path to one file) and calls `kernel.filesystem(name, source)` in `init` to add a type to `mount -t` and `/proc/filesystems`. The kernel runs it as a ZenFS `Async` filesystem: the calls that cannot wait are answered from a copy of the tree in memory and every change is passed on to the module, so the module's calls may be asynchronous (a WASI 0.3 component's all are). The kernel numbers the inodes, since a module has none to give, and the module cannot unload while it is mounted. `mount -o lazy` keeps no copy at all: nothing is read at mount and every call goes to the module, for a tree too big to hold in memory, but the calls that cannot wait (`statSync` and the like) then fail with `ENOTSUP`. `core/kernel/examples/wasm-ramfs-rust` is a Rust filesystem, `mount -t wasmram /mnt/x`, a tree kept in the module's memory (106 KB)
- The `zip`, `tar` and `iso` types (module `archives`) and the `dropbox` and `googledrive` types (module `cloud`) are not in the boot bundle: `mount -t` fetches the module from the site's catalog (`/modules/index.json`; `modules` in the kernel options or `ECMAOS_MODULES` changes it, `false` or `none` turns it off) the first time it is asked for, keeps it in `/lib/modules/RELEASE/kernel/`, and loads it. `modules.builtin` lists the types the kernel has without a module (`modprobe` has nothing to load for those). `pnpm --filter @ecmaos/kernel build` builds them (`scripts/build-modules.mjs`; the sources are `core/kernel/modules/NAME/`), taking ZenFS and its helpers from the kernel (`ctx.import('lib:@zenfs/core')`) and bundling the rest
- To sign the in-tree modules, run `node core/kernel/scripts/module-key.mjs DIR` once (it writes `ecmaos.key`, which stays private, and `ecmaos.pub`), build with `ECMAOS_MODULE_KEY=DIR/ecmaos.key` so each module gets a signature, and put the base64 line of `ecmaos.pub` in `core/kernel/src/tree/lib/module-release-key.json` (or set `ECMAOS_MODULE_PUBKEY` for one build): boot writes it to `/etc/modules-keys/ecmaos.pub`, so those modules load with only the `O` taint. The key comes from the kernel's own build, never from the catalog
- Signing: `sign-module --genkey NAME` makes `NAME.key` and `NAME.pub`, `sign-module -k NAME.key FILE` appends an Ed25519 signature to the module, and a key copied to `/etc/modules-keys` is trusted; a module signed by a trusted key does not taint `E`, a signature that does not match is refused, and writing 1 to `/proc/sys/kernel/module_sig_enforce` refuses every module that is not signed by a trusted key until reboot
- `kernel_api` is a semver range of the module API (`1.0.0`); a module that asks for another version fails with `ENOEXEC`, and `insmod -f` loads it anyway
- A package ships a module by listing it in its `package.json`, `"ecmaos": { "modules": ["dist/NAME.ko.mjs"] }` (`.ko.mjs` or `.ko.wasm` files inside the package): `install` copies each into `/lib/modules/RELEASE/` and runs `depmod`, so `modprobe NAME` finds it, and `uninstall` takes them away again (root only, like `insmod`). `turbo gen module` asks whether the module is TypeScript (`build.mjs` bundles `src/index.ts` with esbuild into `dist/NAME.ko.mjs` under the modinfo header made from `module.json`, and `pnpm test` loads it) or Rust (a WASI 0.3 component built by `scripts/build-wasm-rust.mjs`); `modules/boilerplate` is the TypeScript one; both builds sign the module when `ECMAOS_MODULE_KEY` names a private key file (`node core/kernel/scripts/module-key.mjs DIR` makes one; `ECMAOS_MODULE_SIGNER` names the signer), and unsigned they load with the `E` taint

### Packages

- Packages are [NPM packages](https://www.npmjs.com) that are installed into the ecmaOS environment
- They can be installed from the terminal using the `install` command, e.g. `# install @ecmaos-apps/ai`
- Client-side packages should work well
- Some basic Node emulation is in place, but don't expect anything to work at this point
- NPM version specifiers are supported, e.g.:
  - `# install jquery@3.7.1`
  - `# install jquery@^3.7.1`
  - `# install jquery@latest`
- [JSR](https://jsr.io) may be used with the [NPM compatibility layer](https://jsr.io/docs/npm-compatibility):
  - `# install @jsr/defaude__hello-jsr --registry https://npm.jsr.io`

### Screensavers

- Current options: `blank`, `matrix`, `toasters`
- This whole system will be revamped in the future
- Screensavers are currently built into the kernel, but will be migrated to external apps
- You can start the screensaver with the `screensaver` command
- You can set the default screensaver with the `screensaver --set <name>` command
- The screensaver timeout can be set with a `screensaver-timeout` `localStorage` key with the value in milliseconds (default: 60000)

### Shell

- The shell manages the environment, filesystem context, execution, and terminal interface
- System-wide terminal configuration is stored in `/etc/terminal.toml`
- User-specific terminal configuration is stored in `~/.config/terminal.toml`
- Startup files are run at login, in order: `/etc/profile`, `/etc/profile.d/*.sh`, the first of `~/.bash_profile`, `~/.ecmash_profile` or `~/.profile`, `/etc/ecmashrc`, `~/.bashrc`, `~/.ecmashrc`
- See [tutorials/shell-customization.md](/tutorials/shell-customization.md) for more information

### Sockets

> [/core/kernel/src/tree/lib/main-thread-syscalls.ts](/core/kernel/src/tree/lib/main-thread-syscalls.ts)

- A real `socket()`/`bind()`/`listen()`/`connect()`/`accept()` POSIX socket implementation runs natively in the worker (`AF_UNIX`, and loopback `AF_INET` and `AF_INET6` between programs on the machine). A `connect()` to any other IPv4 or IPv6 address goes through the gateway if `gateway up` has made one (see [Network gateway](#network-gateway)) and fails with `-ENETUNREACH` otherwise.
- For an actual external connection, use `nc` (which speaks WebSocket under the hood) or the `sockets` command/`kernel.sockets` manager, both of which create real `WebSocket`/`WebTransport` connections on the main thread and bridge them to a worker-hosted process's stdio.
- See [Known gaps](#known-gaps) for what this does and doesn't cover, and `man sockets` for the full address-family breakdown once installed.

### Network gateway

> [/core/kernel/src/tree/lib/remote-gateway.ts](/core/kernel/src/tree/lib/remote-gateway.ts), [/core/node/src/gateway.ts](/core/node/src/gateway.ts)

- A browser tab cannot open a TCP socket, so the machine borrows one: `gateway up root@host:30022` (root only) logs in to an ecmaOS machine started with `ecmaos --listen --gateway` and keeps the link. From then on a program's `connect()` to an IPv4 or IPv6 address that is not this machine (a WASM program's `socket()`/`connect()`, for one) is a flow through that machine, which makes the real connection; the program reads, writes, polls and closes an ordinary socket.
- The host decides what is reachable: its own network, private ranges and metadata addresses are refused unless a rule names them, and every flow is logged there. A refusal reaches the program as `EACCES`, a dead destination as `ECONNREFUSED`/`EHOSTUNREACH`/`ETIMEDOUT`, and no gateway as `ENETUNREACH`. `gateway down` closes the link; `gateway` shows it. `nc -g` is the one-command form. See `man gateway`.
- Names: `getaddrinfo()`/`gethostbyname()` in a WASM program read `/etc/hosts` (shipped with `localhost`), then ask the gateway, which resolves with its own resolver and does not hand out addresses it would not connect to. With no gateway a name that is not in `/etc/hosts` fails with `EAI_AGAIN`. A program built on musl (python3, perl) does its own lookups against `/etc/resolv.conf`, which names 127.0.0.1: the kernel answers A and AAAA queries sent to loopback port 53 the same way (`dns-stub.ts`), unless a program has bound that port itself.
- UDP: a program's `SOCK_DGRAM` socket gets a flow to one peer (`connect()` or the first `sendto()`), one datagram per message with boundaries kept; it is not flow controlled, so datagrams are dropped when the link falls behind.
- Inbound: `gateway expose 3000 8080` (root) asks the gateway's host to open port 8080 and forward each connection to port 3000 on this machine, where a program listens on loopback (an ordinary `bind()`/`listen()`/`accept()`; the program is unchanged). The host opens nothing unless its operator named ports (`--gateway-listen`), binds to its own loopback unless told otherwise, and logs each connection. The host's `--gateway-listen-allow` limits which clients may connect, and `accept()`/`recvfrom()` report the real client address. `gateway expose -u 5300 5353` does the same for UDP: datagrams to the host's port reach a program that `bind()`ed 5300, naming each sender, and `sendto()` answers any of them from the one socket. `gateway unexpose 8080` stops it; `gateway` lists what is exposed. A connection with nothing listening on the port is dropped.
- IPv6: `AF_INET6` sockets work as on a dual-stack Linux machine. `sockaddr_in6` is read and written everywhere (`bind`, `connect`, `accept`, `getsockname`, `getpeername`, `sendto`, `recvfrom`, `sendmsg`, `recvmsg`), `getaddrinfo()` returns AAAA answers (IPv4 first when no family is asked for) and `getnameinfo()` answers from `/etc/hosts`. An IPv6 socket bound to `::` also takes IPv4 clients, shown as `::ffff:a.b.c.d`, unless `IPV6_V6ONLY` is set; `::1` and `::` are this machine, and an IPv4 port and an IPv6-only port with the same number do not collide. Beyond the machine an IPv6 address is a flow through the gateway like any other, `gateway expose` can open an IPv6 address on the host (`--gateway-listen-address ::1`), and a client's real IPv6 address reaches `accept()`/`recvfrom()`. The loopback model is shared: a UDP port is one name for both families.
- Ancillary data: on a local `AF_UNIX` connection (`bind`/`listen`/`connect`/`accept`; emscripten's libc has no `socketpair`) `sendmsg`/`recvmsg` pass descriptors with `SCM_RIGHTS`: files, pipes, ttys and connected sockets, between two programs or within one. A descriptor stays open while it is in flight even if the sender closes it, arrives in the receiver's table at its lowest free number, and travels with the first byte of the message it was sent with: a read never runs across such a message, an ordinary `read()` past it drops the descriptor, and a control buffer too small gives `MSG_CTRUNC`. `SO_PEERCRED` gives the other program's pid, uid and gid, and `SO_PASSCRED` has them arrive with each message as `SCM_CREDENTIALS`. Other kinds (`IP_PKTINFO` and the rest) are ignored on send and absent on receive, and rights on any other kind of socket fail with `EINVAL`. Descriptors pass between an Emscripten program and a WALI one as between two of a kind: the kernel hands them across (a WALI Wayland client and the compositor share keymaps and `wl_shm` pools that way); an Emscripten program's socket sent to a WALI one is refused with `EINVAL`.

### SWAPI

> [/core/swapi](/core/swapi)

- The SWAPI is an API server running completely inside a service worker using [Hono](https://hono.dev)
- It allows for various operations including the `fs` route to fetch files via URL
- e.g., `# fetch /swapi/fs/home/user/hello.txt`
- e.g., `# fetch /swapi/fake/person/fullName`

### Telemetry

- [OpenTelemetry](https://opentelemetry.io) is used for collecting and analyzing telemetry data from the kernel and applications
- It is only active if the ECMAOS_OPENTELEMETRY_ENDPOINT environment variable is set when building the kernel
- There is a simple test server included in the `utils/opentelemetry` directory that can be used to test the telemetry system: `python3 utils/opentelemetry/otlp-server.py`

### Utils

> [/utils](/utils)

- Utilities and configuration used during development

## Important Files and Directories

- `/bin/`: Built-in commands
- `/sbin/init`: pid 1, the first process; it runs `/etc/inittab`
- `/sbin/getty`: the login prompt on one terminal, run by init for each of the eight (it asks for the user name and runs `/bin/login`, which asks for the password and runs the shell)
<!-- - `/bios/`: The BIOS filesystem -->
- `/boot/init`: A script that runs on boot, as a `sysinit` entry of `/etc/inittab`
- `/etc/inittab`: What init runs and keeps running (BusyBox format; see `man @ecmaos/coreutils/inittab`)
- `/dev/`: All devices are here
- `/etc/crontab`: System-wide crontab file (loaded on boot)
- `/etc/packages`: A list of installed packages to load on boot
- `/etc/terminal.toml`: System-wide terminal configuration
- `/etc/profile`, `/etc/profile.d/*.sh`, `/etc/ecmashrc`: System-wide shell startup files
- `/home/`: Contains user home directories
- `~/.config/crontab`: User-specific crontab file (loaded on login)
- `~/.profile`, `~/.bash_profile`, `~/.ecmash_profile`, `~/.bashrc`, `~/.ecmashrc`: User-specific shell startup files
- `~/.config/terminal.toml`: User-specific terminal configuration
- `/proc/`: Contains various dynamic system information
- `/root/`: The home directory for the root user
- `/usr/bin/`: Executable packages get linked here
- `/usr/lib/`: All installed packages are here
- `/usr/share/licenses/`: License texts, and the source offer for each copyleft program
- `/var/log/kernel.log`: The kernel log

## Command Examples

```sh
ai "Despite all my rage" # use `env OPENAI_API_KEY=`
cat /var/log/kernel.lo
cd /tmp
echo "Hello, world!" > hello.txt
chmod 700 hello.txt
chown user hello.txt
clear
cp /tmp/hello.txt /tmp/hi.txt
cron add "* * * * *" "echo hello" # add a cron job
cron reload # reload crontabs from files
cron list # list all cron jobs
download hello.txt
edit hello.txt
env hello=world ; env
fetch https://ipecho.net/plain > /tmp/myip.txt
fetch -o /tmp/initfs.tar.gz /initfs.tar.gz
fetch /initfs.tar.gz | head | xxd
fetch /xkcd-os.sixel # xterm.js includes sixel support
fetch /swapi/fs/home/user/hello.txt # fetch a file from the filesystem via SWAPI
fetch /swapi/fake/person/fullName # fetch a random person from the SWAPI
install jquery
install @ecmaos-apps/boilerplate
ls /dev
mkdir /tmp/zip ; cd /tmp/zip
upload
mount -t zip myuploaded.zip /mnt/zip
cd .. ; pwd
unzip zip/myuploaded.zip
mv zip/myuploaded.zip /tmp/backup.zip
passwd old new
play /root/test.mp3
ps
rm /tmp/backup.zip
screensaver
snake
stat /tmp/hello.txt
touch /tmp/test.bin
umount /mnt/zip
user add user
su user
sudo cat /etc/shadow
video /root/video.mp4
zip /root/tmp.zip /tmp
```

## Device Examples

```sh
/dev/audio test
/dev/battery status
/dev/bluetooth scan
/dev/bluetooth list
cat /dev/ble0
echo hello > /dev/ble0
cat /dev/battery | xxd
cat /dev/geo
cat /dev/sensor-accelerometer
cat song.mp3 > /dev/audio
cat /dev/usb0
/dev/gamepad list
/dev/geo position
/dev/gpu test
/dev/hid list
/dev/midi list
/dev/presentation start https://wikipedia.org
/dev/sensors list
/dev/serialctl devices
/dev/usb list
/dev/webgpu test
echo "Goodbye" > /dev/null
echo "This will error" > /dev/full
head -c 32 /dev/random > /tmp/random.txt
head -c 32 /dev/zero > /dev/null
```

Bluetooth LE devices are byte streams once paired: `/dev/bluetooth scan` pairs one (this needs a click, as the browser requires), and after a reload each paired device is `/dev/ble0`, `/dev/ble1` and so on. Reading a node returns what the device sends and writing sends bytes to it. Which GATT service and characteristics carry the stream comes from `/etc/bluetooth.toml`; without it the Nordic UART service is used, which most serial-over-BLE modules speak. The same file can set a different service for one device, by name or id:

```toml
chunk = 20

[device."HM-10"]
service = "ffe0"
notify = "ffe1"
write = "ffe1"
```

`/dev/bluetooth` also has `connect`, `disconnect`, `services`, `characteristics`, `read`, `write` and `notify` for working with any characteristic directly. A paired device keeps its `/dev/ble<N>` number when others are forgotten (see below).

Other devices that have a live source are nodes too, and a node's session is opened when a program opens it and closed with the last descriptor, so nothing runs while nobody reads:

- **`/dev/battery`** and **`/dev/geo`** give one reading and then the end of the file, so `cat` returns. `battery` is 18 bytes (level 0 to 100, charging 0 or 1, then seconds to full and to empty as little-endian float64, Infinity when unknown); `geo` is one JSON line with latitude, longitude, accuracy and the rest, and waits for a fix.
- **`/dev/sensor-<kind>`** (`accelerometer`, `gyroscope`, `magnetometer`, `linear`, `gravity`, `orientation`, `light`) exists for each Generic Sensor class the browser has, and streams a JSON line per reading until the reader goes away. The permission has to be granted first; a refusal reads as `EACCES`.
- **`/dev/rtc0`** (and `/dev/rtc`) is the real-time clock, which is the browser's: `RTC_RD_TIME` gives the time in UTC, `RTC_UIE_ON` makes a read wait for each new second, and `hwclock` reads it. It cannot be set. **`/dev/hwrng`** gives random bytes from the browser's generator, as many as are asked for. Both are root's alone, as on Linux.
- **`/dev/audio`** plays what is written to it: write a whole audio file (up to 64 MiB, any format the browser decodes) and it is decoded and played when the file is closed. `/dev/dsp` takes raw signed 16-bit mono samples (16000 Hz) to the speakers, `/dev/dsp1` the same as interleaved stereo at 48000 Hz (what SDL programs play to), and `/dev/dspin` gives the microphone in the same format.
- **`/dev/usb0`, `/dev/usb1`** are the USB devices you have granted (`/dev/usb request`), as byte streams: reads return what the device's IN endpoint sends and writes go to its OUT endpoint. By default the first bulk or interrupt endpoints of the interface are used; `/etc/usb.toml` changes that, for every device or for one by `vendor:product` id or product name:

```toml
interface = 0

[device."2341:0043"]
in = 1
out = 2
```

- **`/dev/hidraw<N>`** and **`/dev/midi<N>`** are the HID devices and MIDI ports the browser has already allowed; the gamepads are under `/dev/input` (see Input, above).
- **`/dev/ttyACM<N>`**, **`/dev/ttyUSB<N>`** and **`/dev/rfcomm<N>`** are the serial ports: a board that speaks CDC ACM (an Arduino, a Raspberry Pi Pico, an ESP32 with native USB), one behind a USB-serial chip (FTDI, CP210x, CH340, PL2303) and a Bluetooth serial port, named as Linux names them. Each is a terminal, with the line discipline and a `c_cflag` that sets the port's speed, character size, parity, stop bits and flow control (`stty -F /dev/ttyACM0 115200 raw`, `microcom -s 115200 /dev/ttyACM0`). A port gets its node when it is granted (`serial request`) or plugged in, with the lowest free number as on Linux, and loses it when it is unplugged; a program that still has it open reads the end of the file. `/dev/serial/by-id/usb-<vendor>_<product>-if00` is a name that stays with the device.

Each driver with several nodes also has a control node (`/dev/usb`, `/dev/serialctl`, `/dev/hid` and so on) that is always there, even where the browser lacks the API, so its command can be run. The number in a `usb<N>`, `ble<N>` or `hidraw<N>` name stays with its device: each is remembered by what identifies it (ids and serial number, or the Bluetooth device id) in `/var/lib/ecmaos/<driver>-minors.json`. Forgetting a device leaves a gap and the others keep their names; a new device gets a number that was never used. Devices that look the same (no serial number) are told apart by the order the browser lists them in. MIDI ports are numbered by position. `/dev/serial` is not the control node: as on Linux it is a directory, holding the `by-id` names of the USB serial ports.

## Code Execution Example

```sh
echo "window.alert('Hello, world!')" > /root/hello.js
load /root/hello.js
```

## Scripting

```txt
#!ecmaos:bin:script
echo "Hello, world!"
install jquery
```

## Startup

- `/sbin/init` is pid 1. It reads `/etc/inittab`, runs `/boot/init` and any other `sysinit` and `wait` entries, then starts the `once` and `respawn` ones (`crond` and one `getty` per terminal are `respawn` entries). It restarts what dies, reaps every child and orphan, and takes the system down in order on `reboot`, `halt` or `poweroff`
- `/etc/crontab` is loaded on boot and contains system-wide scheduled tasks
- `~/.config/crontab` is loaded on user login and contains user-specific scheduled tasks
- `/etc/packages` is a list of already installed packages to load on boot; one per line
- The env var `ECMAOS_RECOMMENDED_APPS` is a list of apps to suggest to new users

## App Development

The [apps](/apps) directory in the repository contains some examples of how to develop apps, but there are many approaches you could take.

- `@ecmaos-apps/boilerplate`: A minimal boilerplate app for reference
- `@ecmaos-apps/code`: A simple code editor app using [Monaco](https://microsoft.github.io/monaco-editor/); serves as a good reference for more complex apps

Basically, your app's [bin](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin) file has a `main` (or unnamed default) function export that is passed the kernel reference and can use it to interact with the system as needed. A shebang line of `#!ecmaos:bin:app:myappname` is required at the top of the bin file to identify it as an app.

There's a second shebang, `#!ecmaos:bin:program:myprogramname`, for a package that isn't a windowed app but still needs main-thread state - `document`, `kernel.i18n`, or another singleton a worker can't reach. Both run through the same `/bin/app` presenter (see [Execution Model](#execution-model)) and get the same `ProcessEntryParams`; `:app:` is for something that opens a window, `:program:` is for something that doesn't but still can't run purely in a worker.

## App/Kernel Interface Example

> See the [docs](https://docs.ecmaos.sh) for more information

```ts
#!ecmaos:bin:app:example
// shebang format: ecmaos:exectype:execnamespace:execname
export default async function main(params: ProcessEntryParams) {
  const { args, kernel, terminal } = params
  kernel.log.info('Hello, world!')
  kernel.log.debug(args)
  terminal.writeln('Hello, world!')
  await kernel.filesystem.fs.writeFile('/tmp/hello.txt', 'Hello, world!')
  const win = kernel.windows.create({ title: 'Example', width: 800, height: 600 })
  const container = document.createElement('div')
  container.innerHTML = '<h1>Hello, world!</h1>'
  win.mount(container)
}
```

## Known gaps

- **The root filesystem lives in memory.** The IndexedDB root is loaded whole at boot and each file is one record, so every file costs its size in RAM (measured: about 1:1, up to 2 GB in a 32 GB desktop Chrome, a 1 GB store booting in 4.9 s), and changing a file rewrites all of it (a 1-byte edit of a 400 MB file stalls the page for about 1.7 s; for a record of 256 KiB or more the write to IndexedDB is put off for 100 ms and merged, so a program appending in small pieces writes the file once per window instead of once per piece, with the in-memory copy always current and `reboot`, `halt` and a takeover flushing first). Very large files will exhaust a tab, a phone sooner, so a file past a limit is refused with `EFBIG` (default 512 MiB on a device reporting 8 GB or more, 256, 128 or 64 MiB below that) and a warning is logged when the total held crosses twice that; set `limits: { maxFileBytes, warnResidentBytes }` in the kernel options (`false` turns one off). `/tmp`, `/media` and `/mnt` are in memory by design and not limited; `mount -t opfs` does not avoid this (its backend copies the whole directory into memory, and a mount that holds 1 MiB or more says so). `df` shows what every mount holds in memory and the limits. `/etc/quota` (`alice 100M`) gives users a storage quota on the root, enforced as `EDQUOT` on a write or truncate that would go over it; see `man quota`.

ecmaOS 1.0.0 runs its execution model on real `execve` processes, but a number of things are deliberately not done, either because the browser can't support them or because they're scoped past this release:

- **No copy-on-write `fork()`.** Processes are created by spawn (`execve`) only - there is no `fork()` that clones an existing process's address space. This is a deliberate scope decision, not a missing feature: a browser worker has no cheap way to clone memory the way a real OS `fork()` does.
- **The site always boots on IndexedDB.** The root is whatever the kernel's `filesystem.mounts['/']` option names (the Node host passes a `node:sqlite` store, a guest session a memory one), but the site has no setting for it, and the one-tab lock and the `?machine=` stores only apply to the default IndexedDB root. OPFS (Origin Private File System) is mountable with `mount -t opfs`; as a root it would not help with memory, since its backend copies the whole directory into memory too.
- **`socket()` reaches the network only through a gateway.** `AF_UNIX` and loopback `AF_INET`/`AF_INET6` sockets work natively in the worker. Browsers expose no raw TCP/UDP, so a `connect()` to another IPv4 or IPv6 address needs `gateway up` (a link to an ecmaOS machine started with `--listen --gateway`, which does the connecting and decides what is reachable); without one it fails with `ENETUNREACH`. Names resolve through `/etc/hosts` and then the gateway, and UDP works with `sendto`/`recvfrom`/`sendmsg`/`recvmsg`: a socket that is not connected talks to any number of peers (it takes a port on first send), a `connect()`ed one keeps to its peer; `AF_INET6` works the same way, dual-stack as on Linux. A program listening on loopback can be reached from outside only through `gateway expose`, if the gateway's operator opened ports for it. `nc` and `sockets_connect` still reach WebSocket/WebTransport servers directly. See [Sockets](#sockets).
- **WASI Preview 2 is 0.2 only, and a component's exit status is success or failure.** A component is transpiled by the kernel with jco (too large to bundle into the worker) and run as a worker process under `/bin/wali` on its own host for the `wasi:*` 0.2 interfaces (`core/kernel/src/bin/wasip2.mjs` and `wasip2-sockets.mjs`): it has a pid, is killable and preemptible, and gets the working directory and preopens (`/`, `.` and each top-level directory, as Preview 1 does), the shell's pipes and redirections or the tty on stdio, a clock, random bytes, TCP and UDP sockets and name lookup (loopback and a local listener directly, anything else through the gateway when `gateway up` made one). WASI 0.2's `exit` only says success or failure, so a nonzero status arrives as 1. A component another program starts is transpiled by the kernel when its worker asks. `wasi:http` is not provided, and a component that imports it, or anything else the host lacks, fails to start with a message. WASI Preview 3 (0.3) is not supported; the interface table is keyed by version so one can be added.
- **`strace` logs; it is not `ptrace`.** It records the system calls a process makes (`strace CMD`, `strace -p PID`), but never stops, steps or inspects the program, and shows arguments as strings and bytes rather than pointers. See `man strace`.
- **initfs isn't extracted via a real `tar`.** `extractTarball` runs before syscalls, processes, or `/bin/tar` itself exist on the filesystem - the tarball being extracted is what provides `/bin/tar` in the first place, so boot uses a small bootstrap extractor instead of the real coreutil. A genuine fix needs a two-phase boot (a tiny bootstrap tarball extracted the current way, then everything else through the real `/bin/tar`). The tarball is `/initfs.tar.gz` everywhere, the dev server included (`ECMAOS_INITFS` overrides it, `none` turns it off); a new filesystem gets all of it, and an existing one gets `/usr/share` (docs, licenses, the Vim runtime) again whenever the tarball changes, leaving `/etc`, `/root` and `/home` alone.
- **The WebGL terminal renderer's ligature behavior is undecided.** No verdict yet on whether/how ligatures should render under the WebGL addon.
- **Programs run as their user only with a newer `@zenfs/core`.** A user's programs, and the shell `login` starts, run with that user's credentials (file permissions, `kill`, `mount` and the other root-only calls apply to them) when the installed `@zenfs/core` can open a file the caller does not own and keeps a user out of a directory they have no search permission on; the kernel checks both once at boot and logs when one is missing. With `@zenfs/core` 2.7.7 both are there (the second because the kernel turns on its `resolveFullWalk`), so programs run as their user. Changing the mode or owner of a directory, or of a read-only file, is not yet something `@zenfs/core` lets an owner do, so `chmod`, `chown` and `chgrp` ask the kernel when their own call is refused: it applies Linux's rule (the owner or root) and makes the change. With an older `@zenfs/core` every program runs as root, and a non-root shell is judged by its own user. `su` and `sudo` are real programs with the setuid bit, which the kernel honours when it starts a program; `su` starts a child shell as the target (root needs no password, anyone else gives the target's), and `sudo` runs a command as another user if `/etc/sudoers` allows it, after the caller's own password. Both need the newer `@zenfs/core` and refuse with a message without it, rather than hand out root. `sudoers` is a subset of the real grammar (aliases are understood; no includes). `crond` runs a user's `~/.config/crontab` jobs as that user in a shell with no terminal (with the older `@zenfs/core` only root's jobs run). `umask` is a real builtin in both shells with the newer `@zenfs/core` (a context has a creation mask, applied to files, directories and `>` redirections; programs inherit it), and says it is unsupported with the published one.
- **init is deliberately small.** It is a BusyBox-style init: runlevels only when `/etc/inittab` has an `initdefault` entry (with `telinit` and `runlevel`), no service dependencies, no `ctrlaltdel` action, and the login prompt is `/sbin/getty` on each terminal (when the kernel is not given credentials to log in with; then it logs that user in itself). `getty` and `login` are a login prompt only: no serial lines, no `login -f`, no PAM. `poweroff` stops the kernel and then tries to close the page, which a browser usually refuses, so in an ordinary tab it behaves like `halt`.

## Early Days

ecmaOS is currently in active development. It is not considered stable and the structure and API are very likely to change in unexpected and possibly unannounced ways. Use cautiously and at your own risk.

Things to keep in mind:

- If things go wrong or break, clear your browser cache and site data for ecmaOS
- The kernel runs in a browser, where it has the most to offer, or in Node (`@ecmaos/node`); it does not need a DOM, but terminals, windows and devices come from whichever host it runs in
- Many features are only available on Chromium-based browsers, and many more behind feature flags
- There will be a lot of technical challenges to overcome, and many things will first be implemented in a non-optimal way
- Command interfaces won't match what you might be used to from a traditional Linux environment; not all commands and options are supported. Over time, Linuxish commands will be fleshed out and made to behave in a more familiar way.

## Development

[Turborepo](https://turbo.build/repo) is used to manage the monorepo, and [pnpm](https://pnpm.io) is used for package management.

PNPM Workspaces:

- [apps](/apps)
- [core](/core)
- [devices](/devices)
- [modules](/modules)
- [utils](/utils)

A good place to start is viewing the `scripts` property of [package.json](./package.json) in the root of the repository.

```bash
# Clone
git clone https://github.com/ecmaos/ecmaos.git

# Install dependencies
cd ecmaos && pnpm install

# Run the dev server
pnpm run dev:kernel

# Run the docs server (optional)
pnpm run dev:docs

# Build
pnpm run build

# Run tests
pnpm run test
pnpm run test:watch
pnpm run test:coverage
pnpm run test:bench
pnpm run test:ui

# Generate modules
turbo gen app # generate a new app template
turbo gen device # generate a new device template
turbo gen module # generate a new module template
```

Also see [turbo.json](./turbo.json) and [CONTRIBUTING.md](/CONTRIBUTING.md) for more information.

## Licensing

ecmaOS itself (the kernel, `@ecmaos/coreutils`, and the other packages here) is MIT OR Apache-2.0. Some programs it runs are other people's software, built to WebAssembly, and keep their own licenses; they are kept in separate packages and separate files so the license of each is never in doubt.

- **`@ecmaos/coreutils`** (`core/utils`) ships the JavaScript commands and the permissively licensed programs: `bc`/`dc` (BSD-2-Clause), `jq` (MIT and others), `lua` (MIT), `sqlite3` (public domain, with BSD-2-Clause linenoise), `bzip2`, `xz` (0BSD), `zstd` (BSD-3-Clause), `brotli` (MIT), `mandoc` (ISC), `qjs` (MIT), `patch` (0BSD), `ncdu` (MIT), `mg` (public domain) and `micropython` (MIT, with the Python License for the frozen modules derived from CPython), and the desktop demos: `wldemo` and the SDL programs (`sdlsnake`, `sdlpaint`, `sdlclip`, `sdlpad`, `sdlgl`, `sdlgears`) link libwayland-client and the xdg-shell protocol code (MIT) and libxkbcommon (MIT), and the SDL ones SDL 3 (zlib). Their notices are in `core/utils/licenses/`.
- **`@ecmaos/coreutils-copyleft`** (`core/utils-copyleft`) ships the copyleft programs: GNU `make`, GNU `nano` and GNU `screen` (GPL-3.0-or-later), GNU `ed`, `lz4`, `tree`, `doom` (GPL-2.0-or-later; doomgeneric, linked with SDL 3, libwayland and libxkbcommon) and the ALSA tools `aplay`, `arecord`, `amixer` and `speaker-test` (GPL-2.0-or-later; alsa-lib, LGPL-2.1-or-later, linked in), `vim` (the Vim license) and `perl` (the Artistic License or the GPL). It carries their license texts, the build scripts and the changes ecmaOS made, and the upstream source archives (`sources/`, pinned by sha256 in its manifest). A site that serves these binaries serves that source at `/sources/` too; `licenses/<program>/SOURCE` is the written offer.
- **The kernel bundle contains none of them.** Programs are separate `.wasm` files served under `/programs/` with a catalog, and each is run as a process of its own, never imported as a library; that is what keeps them separate works from the kernel. `@ecmaos/kernel` does not publish them.
- **A build without copyleft programs:** set `ECMAOS_COPYLEFT=0` when building the kernel (or leave `@ecmaos/coreutils-copyleft` out). The site then serves only the permissive ones.

Everything is also in the running system: the texts are in `/usr/share/licenses/@ecmaos/`, one directory per package and program.

### Third-party notices

- **[ZenFS](https://github.com/zen-fs/core)** (`@zenfs/core`, `@zenfs/linux`, `@zenfs/dom`, `@zenfs/archives`, `@zenfs/cloud`, `@zenfs/emscripten`, `@zenfs/streams`), Copyright © James Prevett and other ZenFS contributors, licensed under the [LGPL 3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.html) and [COPYING.md](https://github.com/zen-fs/core/blob/main/COPYING.md). ecmaOS is built on it and is grateful to it. It is a dependency, bundled by the build and not copied into this repository, and it is not modified.
- **[utilium](https://github.com/james-pre/utilium) and [memium](https://github.com/james-pre/memium)**, by the same author and also bundled, are the LGPL 3.0 or later with no web-application exception.
- **What carries them:** the site (a web application, which the ZenFS exception covers), the Node host `@ecmaos/node` (ZenFS and the two libraries are bundled into `dist/ecmaos.mjs`) and the desktop app `@ecmaos/jaffa`. The last two ship the library texts in a `licenses/` folder, and every distribution has them in the running system, in `/usr/share/licenses/` (`licenses` lists them and prints any of them).
- **Using your own copy.** To build ecmaOS (the site, the Node host or the desktop app) against a modified copy of any of these libraries, point the dependency at your copy and rebuild; the steps are in `/usr/share/licenses/@zenfs/README.md` (the same file is in the repository under `core/kernel/public/initfs/`).
- **The rest of the dependency tree** (about 300 packages in production) is MIT, Apache-2.0, BSD, ISC, MPL-2.0 (`lightningcss`, a build tool, unmodified) or similar; `pnpm check:licenses` fails when a dependency is under a license that is not on the list in `scripts/license-allowlist.json`.

### Contributing and license checks

Contributions are licensed under the license of the directory they touch (MIT OR Apache-2.0, and the program's own license under `core/utils-copyleft`), and each commit carries a `Signed-off-by` line ([the Developer Certificate of Origin](https://developercertificate.org/)); see [CONTRIBUTING.md](/CONTRIBUTING.md). `REUSE.toml` states the license of every file, and CI runs `reuse lint`, `pnpm check:licenses` (dependencies) and `pnpm check:license-boundary` (the kernel and `@ecmaos/coreutils` never import the copyleft package).

## Security Vulnerabilities

See [SECURITY.md](/SECURITY.md) for more information.

If you find a serious security vulnerability, please submit a new [Draft Security Advisory](https://github.com/ecmaos/ecmaos/security) or contact the project maintainer directly at [code@mathis.network](mailto:code@mathis.network).
