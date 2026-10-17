# The Web OS

[![Launch ecmaOS.sh](https://img.shields.io/badge/launch-ecmaos.sh-blue?style=for-the-badge)](https://ecmaos.sh)

> Made with ❤️ by [Jay Mathis](https://jaymath.is)
>
> [![Stars](https://img.shields.io/github/stars/mathiscode?style=flat&logo=github&label=⭐️)](https://github.com/mathiscode) [![Followers](https://img.shields.io/github/followers/mathiscode?style=flat&logo=github&label=follow)](https://github.com/mathiscode)

[ecmaOS](https://ecmaos.sh) is a browser-based operating system kernel and suite of applications written primarily in TypeScript, AssemblyScript, and C++. It's the successor of [web3os](https://github.com/web3os-org/kernel).

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
[![GitHub license](https://img.shields.io/badge/license-MIT+Apache2.0-success)](https://github.com/ecmaos/ecmaos/blob/main/LICENSE)

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

- TypeScript, WebAssembly, AssemblyScript, Rust, C++
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
- **`/bin/wali`** ([/core/kernel/src/bin/wali.mjs](/core/kernel/src/bin/wali.mjs)) runs WALI-format WebAssembly modules - musl compiled to call `@zenfs/linux`'s real kernel syscalls (`SYS_open`, `SYS_read`, ...) directly, not through a WASI ABI. WALI and WASI Preview 1 are different, incompatible module formats. Plain WASI Preview 1 modules that qualify (`Wasm.canRunInWorker`) also run as real worker processes; a WASI Preview 1/2 module that can't (e.g. it imports memory in a way the worker path doesn't support) falls back to a main-thread loader, `Wasm.run`/`runComponent`.
- **Emscripten programs** run under `/bin/wali` too. `core/kernel/src/bin/wasi-preview1.mjs` translates an ordinary (non-standalone) emcc build's `env.__syscall_*` and `wasi_snapshot_preview1` imports onto the real syscalls, so a C program built with `emcc` runs as a worker process with a pid, signals and a controlling terminal. `vim` (and `vi`, a link to it) is the real Vim 9.1 built this way by `core/utils-copyleft/wasm/vim/build.sh`. The binaries are not part of the kernel bundle: each is committed in the package that owns it (`core/utils-copyleft/programs/` for the copyleft ones, `core/utils/programs/` for the permissively licensed ones, each with a `manifest.json`), the site serves them under `/programs/` with a catalog, and boot writes a program into `/bin` only when the installed copy differs from the catalog's. It ships a subset of Vim's runtime (syntax highlighting and filetype detection for common languages, no `:help`), runs shell commands (`:!`, `:r !`, filters) by spawning `/bin/ecmash -c` through `proc_spawn`, and gets `SIGWINCH` and the other signals through the handlers the program set (`ecmaos_signal`, see `core/utils-copyleft/wasm/vim/libc-gaps.c`). Still missing: `:shell`, `:terminal` and jobs. `sqlite3` (the SQLite shell, with linenoise history), `jq`, `lua` (Lua 5.4), `bc` (and `dc`, a link to it), `tree`, `make` (GNU make, one job at a time) and `nano` (with ncurses) are built the same way (`wasm/<name>/build.sh` in `core/utils` or `core/utils-copyleft`), as are `bzip2`, `xz`, `zstd`, `brotli`, `lz4` (with `unlz4` and `lz4cat`), `ed`, `mandoc`, `qjs` (QuickJS), `patch` (toybox), `ncdu`, `mg` and `micropython` (MicroPython 1.29, also `python` and `python3`, with asyncio and a set of micropython-lib modules frozen in; its garbage collector scans the C stack, so the build spills wasm locals to it, see `core/utils/wasm/micropython/build.sh`); the shim answers `system()`, `strptime`, `gmtime`/`timegm`, `readdir` and advisory file locks for them (locks are always granted, so two programs writing one database at once are not kept apart).
- **`/bin/app`** ([/core/kernel/src/tree/lib/presenters/app.ts](/core/kernel/src/tree/lib/presenters/app.ts)) is the presenter for programs that must touch the DOM - `#!ecmaos:bin:app:<name>` (a windowed app like `code` or `webamp`) and `#!ecmaos:bin:program:<name>` (an `@ecmaos-apps/*` package that isn't windowed but still needs `document`, i18n, or other main-thread state). The real process is still a worker with a pid and signals; the app's own `main(params)` runs on the main thread, where it has the live `kernel`/`shell`/`terminal` the DOM-app ABI has always given it, and the process's lifetime is tied to `main`'s return (or the window closing) via a small dispose/keepAlive shim, not a bespoke lifecycle class.
- **Main-thread custom syscalls.** A worker can't reach the DOM, WebAuthn, or the kernel's own singletons directly - only the main thread can. `core/kernel/src/tree/lib/main-thread-syscalls.ts` uses `@zenfs/linux`'s public `define_syscall` to register ecmaOS-specific syscalls (`window_create`, `window_write`, `window_close`, `window_list`, `window_focus`, `window_move`, `window_resize`, `window_set_title`, `storage_usage`, `users_lookup`, `klog`, `proc_spawn`, `proc_wait`, and more) that a worker-hosted process can call like any other syscall; the handler runs on the main thread and the result crosses back over the same `Atomics.wait`-blocking syscall ABI `@zenfs/linux` uses for its own syscalls. This is how a worker-hosted coreutil or kernel command reaches main-thread-only capability without itself running on the main thread.
- **The manifest `syscalls`/`devices` allowlist.** A program at `/path/to/program` may ship a sibling `/path/to/program.manifest.json`: `{ "syscalls": ["read", "write", "openat"], "devices": ["tty", "echo"] }`. When present, `core/kernel/src/tree/lib/syscall-policy.ts` refuses any syscall the manifest doesn't list with `-EPERM` before the real handler runs, and `Kernel.registerDevices()`'s per-major device dispatch enforces `devices` the same way at the point a device node is opened. A program with no manifest is unrestricted (today's default), so the allowlist is opt-in per-program rather than mandatory.

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
- An individual device module can provide multiple device drivers, e.g. `/dev/usb` provides `/dev/usb-mydevice-0001-0002`

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
  - WASM Loader (WASI Preview 1 mostly complete; WASI Preview 2 not supported; WALI supported via `/bin/wali`)
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
- Modules are dynamically loaded into the kernel at boot and can be enabled or disabled
- They are specified during build via the `ECMAOS_KERNEL_MODULES` environment variable
  - e.g. `ECMAOS_KERNEL_MODULES=@ecmaos-modules/boilerplate@0.1.0,@your/package@1.2.3`
- Versions must be pinned and are mandatory - you cannot use NPM version specifiers
- They can provide additional functionality, devices, commands, etc.
- They offer a [common interface](./core/types/modules.ts) for interacting with the kernel
- Generally they should be written in [AssemblyScript](https://www.assemblyscript.org), but this isn't required

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
- Names: `getaddrinfo()`/`gethostbyname()` in a WASM program read `/etc/hosts` (shipped with `localhost`), then ask the gateway, which resolves with its own resolver and does not hand out addresses it would not connect to. With no gateway a name that is not in `/etc/hosts` fails with `EAI_AGAIN`.
- UDP: a program's `SOCK_DGRAM` socket gets a flow to one peer (`connect()` or the first `sendto()`), one datagram per message with boundaries kept; it is not flow controlled, so datagrams are dropped when the link falls behind.
- Inbound: `gateway expose 3000 8080` (root) asks the gateway's host to open port 8080 and forward each connection to port 3000 on this machine, where a program listens on loopback (an ordinary `bind()`/`listen()`/`accept()`; the program is unchanged). The host opens nothing unless its operator named ports (`--gateway-listen`), binds to its own loopback unless told otherwise, and logs each connection. The host's `--gateway-listen-allow` limits which clients may connect, and `accept()`/`recvfrom()` report the real client address. `gateway expose -u 5300 5353` does the same for UDP: datagrams to the host's port reach a program that `bind()`ed 5300, naming each sender, and `sendto()` answers any of them from the one socket. `gateway unexpose 8080` stops it; `gateway` lists what is exposed. A connection with nothing listening on the port is dropped.
- IPv6: `AF_INET6` sockets work as on a dual-stack Linux machine. `sockaddr_in6` is read and written everywhere (`bind`, `connect`, `accept`, `getsockname`, `getpeername`, `sendto`, `recvfrom`, `sendmsg`, `recvmsg`), `getaddrinfo()` returns AAAA answers (IPv4 first when no family is asked for) and `getnameinfo()` answers from `/etc/hosts`. An IPv6 socket bound to `::` also takes IPv4 clients, shown as `::ffff:a.b.c.d`, unless `IPV6_V6ONLY` is set; `::1` and `::` are this machine, and an IPv4 port and an IPv6-only port with the same number do not collide. Beyond the machine an IPv6 address is a flow through the gateway like any other, `gateway expose` can open an IPv6 address on the host (`--gateway-listen-address ::1`), and a client's real IPv6 address reaches `accept()`/`recvfrom()`. The loopback model is shared: a UDP port is one name for both families.
- Ancillary data: on a local `AF_UNIX` connection (`bind`/`listen`/`connect`/`accept`; emscripten's libc has no `socketpair`) `sendmsg`/`recvmsg` pass descriptors with `SCM_RIGHTS`: files, pipes, ttys and connected sockets, between two programs or within one. A descriptor stays open while it is in flight even if the sender closes it, arrives in the receiver's table at its lowest free number, and travels with the first byte of the message it was sent with: a read never runs across such a message, an ordinary `read()` past it drops the descriptor, and a control buffer too small gives `MSG_CTRUNC`. `SO_PEERCRED` gives the other program's pid, uid and gid, and `SO_PASSCRED` has them arrive with each message as `SCM_CREDENTIALS`. Other kinds (`IP_PKTINFO` and the rest) are ignored on send and absent on receive, and rights on any other kind of socket fail with `EINVAL`.

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
/dev/serial devices
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
- **`/dev/audio`** plays what is written to it: write a whole audio file (up to 64 MiB, any format the browser decodes) and it is decoded and played when the file is closed. `/dev/dsp` takes raw signed 16-bit mono samples (16000 Hz) to the speakers, `/dev/dsp1` the same as interleaved stereo at 48000 Hz (what SDL programs play to), and `/dev/dspin` gives the microphone in the same format.
- **`/dev/usb0`, `/dev/usb1`** are the USB devices you have granted (`/dev/usb request`), as byte streams: reads return what the device's IN endpoint sends and writes go to its OUT endpoint. By default the first bulk or interrupt endpoints of the interface are used; `/etc/usb.toml` changes that, for every device or for one by `vendor:product` id or product name:

```toml
interface = 0

[device."2341:0043"]
in = 1
out = 2
```

- **`/dev/hidraw<N>`**, **`/dev/midi<N>`**, **`/dev/js<N>`** and **`/dev/ttyS<N>`** are the HID devices, MIDI ports, gamepads and serial ports the browser has already allowed.

Each driver with several nodes also has a control node (`/dev/usb`, `/dev/serial`, `/dev/hid` and so on) that is always there, even where the browser lacks the API, so its command can be run. The number in a `usb<N>`, `ble<N>`, `ttyS<N>` or `hidraw<N>` name stays with its device: each is remembered by what identifies it (ids and serial number, or the Bluetooth device id) in `/var/lib/ecmaos/<driver>-minors.json`. Forgetting a device leaves a gap and the others keep their names; a new device gets a number that was never used. Devices that look the same (no serial number) are told apart by the order the browser lists them in. MIDI ports are numbered by position.

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
- The env var `ECMAOS_KERNEL_MODULES` is a list of modules to load on boot; CSV with pinned versions
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
- **The OPFS root isn't selectable.** The root filesystem is hardcoded to IndexedDB (`Filesystem`, `core/kernel/src/tree/filesystem.ts`). OPFS (Origin Private File System) is mountable as a secondary filesystem via `mount -t opfs`, but you can't boot with OPFS as `/`.
- **`socket()` reaches the network only through a gateway.** `AF_UNIX` and loopback `AF_INET`/`AF_INET6` sockets work natively in the worker. Browsers expose no raw TCP/UDP, so a `connect()` to another IPv4 or IPv6 address needs `gateway up` (a link to an ecmaOS machine started with `--listen --gateway`, which does the connecting and decides what is reachable); without one it fails with `ENETUNREACH`. Names resolve through `/etc/hosts` and then the gateway, and UDP works with `sendto`/`recvfrom`/`sendmsg`/`recvmsg`: a socket that is not connected talks to any number of peers (it takes a port on first send), a `connect()`ed one keeps to its peer; `AF_INET6` works the same way, dual-stack as on Linux. A program listening on loopback can be reached from outside only through `gateway expose`, if the gateway's operator opened ports for it. `nc` and `sockets_connect` still reach WebSocket/WebTransport servers directly. See [Sockets](#sockets).
- **A main-thread, non-asyncify WASM module can't be preempted.** WASI Preview 1/2 modules that qualify for the worker path (`Wasm.canRunInWorker`) run as real, killable processes under `/bin/wali`. A module that doesn't qualify falls back to a main-thread loader that calls `_start` directly with no yield point unless the module itself was compiled with asyncify - a genuine infinite loop on that path freezes the tab, and `^C` cannot reach it, because the same main thread that would notice the keypress is the one spinning. This is a provable ceiling of that fallback path, not an open bug.
- **No WASI Preview 2 (P3) support.** WASI Preview 1 is mostly complete; WASI Preview 2/components are not supported.
- **`strace` logs; it is not `ptrace`.** It records the system calls a process makes (`strace CMD`, `strace -p PID`), but never stops, steps or inspects the program, and shows arguments as strings and bytes rather than pointers. See `man strace`.
- **initfs isn't extracted via a real `tar`.** `extractTarball` runs before syscalls, processes, or `/bin/tar` itself exist on the filesystem - the tarball being extracted is what provides `/bin/tar` in the first place, so boot uses a small bootstrap extractor instead of the real coreutil. A genuine fix needs a two-phase boot (a tiny bootstrap tarball extracted the current way, then everything else through the real `/bin/tar`). The tarball is `/initfs.tar.gz` everywhere, the dev server included (`ECMAOS_INITFS` overrides it, `none` turns it off); a new filesystem gets all of it, and an existing one gets `/usr/share` (docs, licenses, the Vim runtime) again whenever the tarball changes, leaving `/etc`, `/root` and `/home` alone.
- **The WebGL terminal renderer's ligature behavior is undecided.** No verdict yet on whether/how ligatures should render under the WebGL addon.
- **Programs run as their user only with a newer `@zenfs/core`.** A user's programs, and the shell `login` starts, run with that user's credentials (file permissions, `kill`, `mount` and the other root-only calls apply to them) when the installed `@zenfs/core` can open a file the caller does not own and keeps a user out of a directory they have no search permission on; the kernel checks both once at boot and logs when one is missing. With `@zenfs/core` 2.7.7 both are there (the second because the kernel turns on its `resolveFullWalk`), so programs run as their user. Changing the mode or owner of a directory, or of a read-only file, is not yet something `@zenfs/core` lets an owner do, so `chmod`, `chown` and `chgrp` ask the kernel when their own call is refused: it applies Linux's rule (the owner or root) and makes the change. With an older `@zenfs/core` every program runs as root, and a non-root shell is judged by its own user. `su` and `sudo` are real programs with the setuid bit, which the kernel honours when it starts a program; `su` starts a child shell as the target (root needs no password, anyone else gives the target's), and `sudo` runs a command as another user if `/etc/sudoers` allows it, after the caller's own password. Both need the newer `@zenfs/core` and refuse with a message without it, rather than hand out root. `sudoers` is a subset of the real grammar (aliases are understood; no includes), and `^Z` does not stop what `sudo` runs. `crond` runs a user's `~/.config/crontab` jobs as that user in a shell with no terminal (with the older `@zenfs/core` only root's jobs run). `umask` is a real builtin in both shells with the newer `@zenfs/core` (a context has a creation mask, applied to files, directories and `>` redirections; programs inherit it), and says it is unsupported with the published one.
- **init is deliberately small.** It is a BusyBox-style init: runlevels only when `/etc/inittab` has an `initdefault` entry (with `telinit` and `runlevel`), no service dependencies, no `ctrlaltdel` action, and the login prompt is `/sbin/getty` on each terminal (when the kernel is not given credentials to log in with; then it logs that user in itself). `getty` and `login` are a login prompt only: no serial lines, no `login -f`, no PAM. `poweroff` stops the kernel and then tries to close the page, which a browser usually refuses, so in an ordinary tab it behaves like `halt`.

## Early Days

ecmaOS is currently in active development. It is not considered stable and the structure and API are very likely to change in unexpected and possibly unannounced ways. Use cautiously and at your own risk.

Things to keep in mind:

- If things go wrong or break, clear your browser cache and site data for ecmaOS
- The tests need to be updated and expanded
- The kernel is designed to be run in an environment with a DOM (i.e. a browser)
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

- **`@ecmaos/coreutils`** (`core/utils`) ships the JavaScript commands and the permissively licensed programs: `bc`/`dc` (BSD-2-Clause), `jq` (MIT and others), `lua` (MIT), `sqlite3` (public domain, with BSD-2-Clause linenoise), `bzip2`, `xz` (0BSD), `zstd` (BSD-3-Clause), `brotli` (MIT), `mandoc` (ISC), `qjs` (MIT), `patch` (0BSD), `ncdu` (MIT), `mg` (public domain) and `micropython` (MIT, with the Python License for the frozen modules derived from CPython). Their notices are in `core/utils/licenses/`.
- **`@ecmaos/coreutils-copyleft`** (`core/utils-copyleft`) ships the copyleft programs: GNU `make` and GNU `nano` (GPL-3.0-or-later), GNU `ed`, `lz4` and `tree` (GPL-2.0-or-later) and `vim` (the Vim license). It carries their license texts, the build scripts and the changes ecmaOS made, and the upstream source archives (`sources/`, pinned by sha256 in its manifest). A site that serves these binaries serves that source at `/sources/` too; `licenses/<program>/SOURCE` is the written offer.
- **The kernel bundle contains none of them.** Programs are separate `.wasm` files served under `/programs/` with a catalog, and each is run as a process of its own, never imported as a library; that is what keeps them separate works from the kernel. `@ecmaos/kernel` does not publish them.
- **A build without copyleft programs:** set `ECMAOS_COPYLEFT=0` when building the kernel (or leave `@ecmaos/coreutils-copyleft` out). The site then serves only the permissive ones.

Everything is also in the running system: the texts are in `/usr/share/licenses/@ecmaos/`, one directory per package and program.

### Third-party notices

- **[ZenFS](https://github.com/zen-fs/core)** (`@zenfs/core`, `@zenfs/linux`, `@zenfs/dom`, `@zenfs/archives`, `@zenfs/cloud`, `@zenfs/emscripten`), Copyright © James Prevett and other ZenFS contributors, licensed under the [LGPL 3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.html) and [COPYING.md](https://github.com/zen-fs/core/blob/main/COPYING.md). ecmaOS is built on it and is grateful to it. It is a dependency, bundled by the build and not copied into this repository. Its texts are in `/usr/share/licenses/@zenfs/` in the running system, and in `core/kernel/public/initfs/usr/share/licenses/@zenfs/` here.
- **Using your own ZenFS.** To build ecmaOS (the site, or the Node host, which has ZenFS bundled into `dist/ecmaos.mjs`) against a modified ZenFS, point the dependency at your copy and rebuild; the steps are in `/usr/share/licenses/@zenfs/README.md` (the same file is in the repository under `core/kernel/public/initfs/`).

## Security Vulnerabilities

See [SECURITY.md](/SECURITY.md) for more information.

If you find a serious security vulnerability, please submit a new [Draft Security Advisory](https://github.com/ecmaos/ecmaos/security) or contact the project maintainer directly at [code@mathis.network](mailto:code@mathis.network).
