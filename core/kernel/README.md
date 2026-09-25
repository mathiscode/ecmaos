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
- Window manager powered by [WinBox](https://github.com/nextapps-de/winbox)
<!-- - `BIOS`: A C++ module compiled to WebAssembly with [Emscripten](https://emscripten.org) providing performance-critical functionality -->
<!-- - `Jaffa`: A [Tauri](https://tauri.app) app for running ecmaOS in a desktop or mobile environment -->
- `Metal`: An API server for allowing connections to physical systems from ecmaOS using [Hono](https://hono.dev)
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

<!-- Will revamp once more work is done on this -->
<!-- ### BIOS

> [/core/bios](/core/bios)

- The BIOS is a C++ module compiled to WebAssembly with [Emscripten](https://emscripten.org) providing performance-critical functionality
- The BIOS has its own filesystem, located at `/bios` — this allows data to be copied in and out of the BIOS for custom code and utilities
- The main idea is that data and custom code can be loaded into it from the OS for WASM-native performance, as well as providing various utilities
- Confusingly, the Kernel loads the BIOS — not the other way around -->

### Execution Model

> [/core/kernel/src/tree/kernel.ts](/core/kernel/src/tree/kernel.ts) · [/core/kernel/src/bin](/core/kernel/src/bin)

Every runnable file in ecmaOS -- a coreutil, a kernel command, an app, a WASM binary -- is dispatched the same way: `Kernel.execute` reads the file's header (a shebang or magic bytes) and routes it to a real, worker-hosted `execve` process (from `@zenfs/linux`'s process/thread model), not to a hand-rolled in-process class. That process has a real pid, real signals, and a real exit code, and can be `kill`ed, waited on (`proc_wait`), and listed (`ps`) like any other process.

- **`/bin/node`** ([/core/kernel/src/bin/node.mjs](/core/kernel/src/bin/node.mjs)) runs any plain JavaScript program (`#!ecmaos:bin:node`, or a coreutil with no shebang) inside the worker, with a small `globalThis.ecmaosSyscalls` bridge to the real syscall table. This is how every `@ecmaos/coreutils` command runs -- `cat`, `ls`, `grep`, `free`, and the rest are just JS files executed this way, not special-cased kernel code.
- **`/bin/wali`** ([/core/kernel/src/bin/wali.mjs](/core/kernel/src/bin/wali.mjs)) runs WALI-format WebAssembly modules -- musl compiled to call `@zenfs/linux`'s real kernel syscalls (`SYS_open`, `SYS_read`, ...) directly, not through a WASI ABI. WALI and WASI Preview 1 are different, incompatible module formats. Plain WASI Preview 1 modules that qualify (`Wasm.canRunInWorker`) also run as real worker processes; a WASI Preview 1/2 module that can't (e.g. it imports memory in a way the worker path doesn't support) falls back to a main-thread loader, `Wasm.run`/`runComponent`.
- **`/bin/app`** ([/core/kernel/src/tree/lib/presenters/app.ts](/core/kernel/src/tree/lib/presenters/app.ts)) is the presenter for programs that must touch the DOM -- `#!ecmaos:bin:app:<name>` (a windowed app like `code` or `webamp`) and `#!ecmaos:bin:program:<name>` (an `@ecmaos-apps/*` package that isn't windowed but still needs `document`, i18n, or other main-thread state). The real process is still a worker with a pid and signals; the app's own `main(params)` runs on the main thread, where it has the live `kernel`/`shell`/`terminal` the DOM-app ABI has always given it, and the process's lifetime is tied to `main`'s return (or the window closing) via a small dispose/keepAlive shim, not a bespoke lifecycle class.
- **Main-thread custom syscalls.** A worker can't reach the DOM, WebAuthn, or the kernel's own singletons directly -- only the main thread can. `core/kernel/src/tree/lib/main-thread-syscalls.ts` uses `@zenfs/linux`'s public `define_syscall` to register ecmaOS-specific syscalls (`window_create`, `window_write`, `window_close`, `storage_usage`, `ps_list`, `users_lookup`, `klog`, `crontab_load`, `proc_spawn`, `proc_wait`, and more) that a worker-hosted process can call like any other syscall; the handler runs on the main thread and the result crosses back over the same `Atomics.wait`-blocking syscall ABI `@zenfs/linux` uses for its own syscalls. This is how a worker-hosted coreutil or kernel command reaches main-thread-only capability without itself running on the main thread.
- **The manifest `syscalls`/`devices` allowlist.** A program at `/path/to/program` may ship a sibling `/path/to/program.manifest.json`: `{ "syscalls": ["read", "write", "openat"], "devices": ["tty", "echo"] }`. When present, `core/kernel/src/tree/lib/syscall-policy.ts` refuses any syscall the manifest doesn't list with `-EPERM` before the real handler runs, and `Kernel.registerDevices()`'s per-major device dispatch enforces `devices` the same way at the point a device node is opened. A program with no manifest is unrestricted (today's default), so the allowlist is opt-in per-program rather than mandatory.

### Commands

> [/core/kernel/src/bin/commands](/core/kernel/src/bin/commands)

- `Commands` are the kernel's own programs, e.g. `download`, `install`, `load`, `mount`, `passwd`. Each is a real `execve`'d program that reaches main-thread-only capabilities (DOM, WebAuthn, the kernel's singletons) through custom syscalls and presenters, same as any other program in the execution model above.

### Coreutils

> [/core/utils](/core/utils)

- `Coreutils` are similar to `Commands`, but are provided by the `@ecmaos/coreutils` package, e.g. `cat`, `cd`, `chmod`, `cp`, `echo`, `git`, `ls`, `mkdir`, `mv`, `pwd`, `rm`, `rmdir`, `stat`, `touch`, etc. They run under `/bin/node` in the execution model above, using plain filesystem/process syscalls -- no kernel-singleton access, and no shell-state mutation (a coreutil can't change its own shell's cwd or env; that's what the small set of true shell builtins, and `executeCommand`'s in-process `false`/`test`/`true`, are for).

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

<!-- Will revamp once more work is done on this -->
<!-- ### Jaffa

> [/core/jaffa](/core/jaffa)

- Jaffa is a [Tauri](https://tauri.app) wrapper for the ecmaOS kernel
- It's used to tie the kernel into a desktop or mobile environment, allowing for native functionality
- It needs more work -->

### Internationalization

> [/core/kernel/src/tree/i18n](/core/kernel/src/tree/i18n)

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
  - Execution (worker-hosted `execve` processes via `@zenfs/linux`, real pids/signals/exit codes -- see [Execution Model](#execution-model))
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
  - Window Manager (WinBox)

### Metal

> [/core/metal](/core/metal)

- Metal is an API server for allowing connections to physical systems from ecmaOS using [Hono](https://hono.dev)
- Authenticated and encrypted connections with JWK/JWE/JOSE

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
- System-wide shell configuration is stored in `/etc/shell.toml`
- User-specific shell configuration is stored in `~/.config/shell.toml`
- See [tutorials/shell-customization.md](/tutorials/shell-customization.md) for more information

### Sockets

> [/core/kernel/src/tree/lib/main-thread-syscalls.ts](/core/kernel/src/tree/lib/main-thread-syscalls.ts)

- A real `socket()`/`bind()`/`listen()`/`connect()`/`accept()` POSIX socket implementation runs natively in the worker (`AF_UNIX` and loopback `AF_INET`/`AF_INET6` only -- anything that isn't loopback is rejected with `-EAFNOSUPPORT`). This is genuine inter-process socket communication between ecmaOS processes, not a network connection.
- For an actual external connection, use `nc` (which speaks WebSocket under the hood) or the `sockets` command/`kernel.sockets` manager, both of which create real `WebSocket`/`WebTransport` connections on the main thread and bridge them to a worker-hosted process's stdio.
- See [Known gaps](#known-gaps) for what this does and doesn't cover, and `man sockets` for the full address-family breakdown once installed.

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
<!-- - `/bios/`: The BIOS filesystem -->
- `/boot/init`: A script that runs on boot
- `/dev/`: All devices are here
- `/etc/crontab`: System-wide crontab file (loaded on boot)
- `/etc/packages`: A list of installed packages to load on boot
- `/etc/shell.toml`: System-wide shell configuration
- `/home/`: Contains user home directories
- `~/.config/crontab`: User-specific crontab file (loaded on login)
- `~/.config/shell`: User-specific shell configuration
- `/proc/`: Contains various dynamic system information
- `/root/`: The home directory for the root user
- `/usr/bin/`: Executable packages get linked here
- `/usr/lib/`: All installed packages are here
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
video /root/video.mp4
zip /root/tmp.zip /tmp
```

## Device Examples

```sh
/dev/audio test
/dev/battery status
/dev/bluetooth scan
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

- `/boot/init` is a script that runs on boot inside the init process (PID 0)
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

There's a second shebang, `#!ecmaos:bin:program:myprogramname`, for a package that isn't a windowed app but still needs main-thread state -- `document`, `kernel.i18n`, or another singleton a worker can't reach. Both run through the same `/bin/app` presenter (see [Execution Model](#execution-model)) and get the same `ProcessEntryParams`; `:app:` is for something that opens a window, `:program:` is for something that doesn't but still can't run purely in a worker.

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

ecmaOS 1.0.0 runs its execution model on real `execve` processes, but a number of things are deliberately not done, either because the browser can't support them or because they're scoped past this release:

- **No copy-on-write `fork()`.** Processes are created by spawn (`execve`) only -- there is no `fork()` that clones an existing process's address space. This is a deliberate scope decision, not a missing feature: a browser worker has no cheap way to clone memory the way a real OS `fork()` does.
- **The OPFS root isn't selectable.** The root filesystem is hardcoded to IndexedDB (`Filesystem`, `core/kernel/src/tree/filesystem.ts`). OPFS (Origin Private File System) is mountable as a secondary filesystem via `mount -t opfs`, but you can't boot with OPFS as `/`.
- **`socket()` is loopback-only.** `AF_UNIX` and loopback `AF_INET`/`AF_INET6` sockets work natively in the worker; there is no real external `AF_INET` connectivity over raw TCP/UDP (browsers don't expose that). For an external connection, use `nc` or `sockets_connect`, both of which go over a real `WebSocket`/`WebTransport` on the main thread. See [Sockets](#sockets).
- **A main-thread, non-asyncify WASM module can't be preempted.** WASI Preview 1/2 modules that qualify for the worker path (`Wasm.canRunInWorker`) run as real, killable processes under `/bin/wali`. A module that doesn't qualify falls back to a main-thread loader that calls `_start` directly with no yield point unless the module itself was compiled with asyncify -- a genuine infinite loop on that path freezes the tab, and `^C` cannot reach it, because the same main thread that would notice the keypress is the one spinning. This is a provable ceiling of that fallback path, not an open bug.
- **No WASI Preview 2 (P3) support.** WASI Preview 1 is mostly complete; WASI Preview 2/components are not supported.
- **No `strace`.** There is no syscall trace/hook for a running process.
- **initfs isn't extracted via a real `tar`.** `extractTarball` runs before syscalls, processes, or `/bin/tar` itself exist on the filesystem -- the tarball being extracted is what provides `/bin/tar` in the first place, so boot uses a small bootstrap extractor instead of the real coreutil. A genuine fix needs a two-phase boot (a tiny bootstrap tarball extracted the current way, then everything else through the real `/bin/tar`).
- **The WebGL terminal renderer's ligature behavior is undecided.** No verdict yet on whether/how ligatures should render under the WebGL addon.
- **There is no persistent PID 1.** `/boot/init` runs as a script during boot, but it is not itself a long-lived process holding pid 1 that reaps orphans -- that would need a real boot-sequencing redesign and was scoped out of this pass.

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

## Security Vulnerabilities

See [SECURITY.md](/SECURITY.md) for more information.

If you find a serious security vulnerability, please submit a new [Draft Security Advisory](https://github.com/ecmaos/ecmaos/security) or contact the project maintainer directly at [code@mathis.network](mailto:code@mathis.network).
