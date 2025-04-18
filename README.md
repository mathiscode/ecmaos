# The Web Kernel

[![Launch ecmaOS.sh](https://img.shields.io/badge/launch-ecmaos.sh-blue?style=for-the-badge)](https://ecmaos.sh)

> Made with ❤️ by [Jay Mathis](https://jaymath.is)
>
> [![Stars](https://img.shields.io/github/stars/mathiscode?style=flat&logo=github&label=⭐️)](https://github.com/mathiscode) [![Followers](https://img.shields.io/github/followers/mathiscode?style=flat&logo=github&label=follow)](https://github.com/mathiscode)

[ecmaOS](https://ecmaos.sh) is a [browser-based operating system kernel](https://global.discourse-cdn.com/spiceworks/original/4X/8/7/b/87b7be8e7e2cd932affe5449dba69dc16e30d721.gif) and suite of applications written primarily in TypeScript, AssemblyScript, and C++. It's the successor of [web3os](https://github.com/web3os-org/kernel).

The goal is to create a kernel and supporting apps that tie together modern web technologies and utilities to form an "operating system" that can run on modern browsers, not just to create a "desktop experience". It offers the ability to run a wide variety of apps on top of an already (mostly) sandboxed foundation, offering some measure of security by default as well as rich developer tooling. Its main use case is to provide a consistent environment for running web apps, but it has features that allow for more powerful custom scenarios, such as a platform for custom applications, games, and more.

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
[![Bluesky](https://img.shields.io/badge/follow-on%20Bluesky-blue?logo=bluesky&logoColor=white)](https://ecmaos.bsky.social)
[![Reddit](https://img.shields.io/reddit/subreddit-subscribers/ecmaos?style=flat&logo=reddit&logoColor=white&label=r/ecmaos)](https://www.reddit.com/r/ecmaos)

## Features

- TypeScript, WebAssembly, AssemblyScript, Rust, C++
- Filesystem supporting multiple backends powered by [zenfs](https://github.com/zen-fs/core)
- Terminal interface powered by [xterm.js](https://xtermjs.org)
- Pseudo-streams, allowing redirection and piping
- Device framework with a common interface for working with hardware: WebBluetooth, WebSerial, WebHID, WebUSB, etc.
- Some devices have a builtin CLI, so you can run them like normal commands: `# /dev/bluetooth`
- Install any client-side npm package (this doesn't mean it will work out of the box as expected)
- Event manager for dispatching and subscribing to events
- Process manager for running applications and daemons
- Interval manager for scheduling recurring operations
- Memory manager for managing pseudo-memory: Collections, Config, Heap, and Stack
- Storage manager for managing Storage API capabilities: IndexedDB, localStorage, etc.
- Internationalization framework for translating text powered by [i18next](https://www.i18next.com)
- Window manager powered by [WinBox](https://github.com/nextapps-de/winbox)
- `BIOS`: A C++ module compiled to WebAssembly with [Emscripten](https://emscripten.org) providing performance-critical functionality
- `Jaffa`: A [Tauri](https://tauri.app) app for running ecmaOS in a desktop or mobile environment
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
- Then to install from your local registry, run `# install @myscope/mypackage --registry http://localhost:4873`

### BIOS

> [/core/bios](/core/bios)

- The BIOS is a C++ module compiled to WebAssembly with [Emscripten](https://emscripten.org) providing performance-critical functionality
- The BIOS has its own filesystem, located at `/bios` — this allows data to be copied in and out of the BIOS for custom code and utilities
- The main idea is that data and custom code can be loaded into it from the OS for WASM-native performance, as well as providing various utilities
- Confusingly, the Kernel loads the BIOS — not the other way around

### Commands

> [/core/kernel/src/tree/lib/commands](/core/kernel/src/tree/lib/commands)

- Commands are small utilities that aren't quite full Apps, provided by the shell
- Some builtin commands that exist now will be moved into separate apps over time

### Devices

> [/devices](/devices)

- Refer to the full list of [official devices on npm](https://www.npmjs.com/org/ecmaos-devices)
- See the [DEVICES.md](/DEVICES.md) file for a list of community devices; submit a PR to add your device!
- Devices get loaded on boot, e.g. `/dev/bluetooth`, `/dev/random`, `/dev/battery`, etc.
- A device can support being "run" by a user, e.g. `# /dev/battery status`
- Devices may also be directly read/written using `fs` methods, and will behave accordingly (or have no effect if not supported)
- An individual device module can provide multiple device drivers, e.g. `/dev/usb` provides `/dev/usb-mydevice-0001-0002`

### Generators

> [/turbo/generators](/turbo/generators)

- Generators are used to scaffold new apps, devices, modules, etc.
- They are located in the `turbo/generators` directory of the repository
- They are used by the `turbo gen` command, e.g. `turbo gen app`, `turbo gen device`, `turbo gen module`, etc.

### Jaffa

> [/core/jaffa](/core/jaffa)

- Jaffa is a [Tauri](https://tauri.app) wrapper for the ecmaOS kernel
- It's used to tie the kernel into a desktop or mobile environment, allowing for native functionality

### Kernel

> [/core/kernel](/core/kernel)

- The kernel ties together the various components of the system into a cohesive whole
  - Authentication (WebAuthn)
  - Components (Web Components/Custom Elements)
  - Devices
  - DOM
  - Events (CustomEvents)
  - Filesystem (ZenFS)
  - Internationalization (i18next)
  - Interval Manager (setInterval)
  - Log Manager (tslog)
  - Memory Manager (Abstractions)
  - Process Manager
  - Protocol Handlers (web+ecmaos://...)
  - Service Worker Manager
  - Shell
  - Storage (IndexedDB, localStorage, sessionStorage, etc.)
  - Terminal (xterm.js)
  - User Manager
  - WASM Loader
  - [WebContainer](https://github.com/stackblitz/webcontainer-core) for running Node.js apps
  - Window Manager (WinBox)
  - Workers (Web Workers)

### Metal

> [/core/metal](/core/metal)

- Metal is an API server for allowing connections to physical systems from ecmaOS using [Hono](https://hono.dev)
- Authenticated and encrypted connections with JWK/JWE/JOSE

### Modules

> [/modules](/modules)

- Refer to the full list of [official modules on npm](https://www.npmjs.com/org/ecmaos-modules)
- See the [MODULES.md](/MODULES.md) file for a list of community modules; submit a PR to add your module!
- Modules are dynamically loaded into the kernel at boot and can be enabled or disabled
- They are specified during build via the `VITE_KERNEL_MODULES` environment variable
  - e.g. `VITE_KERNEL_MODULES=@ecmaos-modules/boilerplate@0.1.0,@your/package@1.2.3`
- Versions must be pinned and are mandatory - you cannot use NPM version specifiers
- They can provide additional functionality, devices, commands, etc.
- They offer a [common interface](./core/types/modules.ts) for interacting with the kernel
- Generally they should be written in [AssemblyScript](https://www.assemblyscript.org), but this isn't required

### Packages

- Packages are [NPM packages](https://www.npmjs.com) that are installed into the ecmaOS environment
- They can be installed from the terminal using the `install` command, e.g. `# install jquery`
- Client-side packages should work well
- Some basic Node emulation is in place, but don't expect anything to work at this point
- NPM version specifiers are supported, e.g.:
  - `# install jquery@3.7.1`
  - `# install jquery@^3.7.1`
  - `# install jquery@latest`
- [JSR](https://jsr.io) may be used with the [NPM compatibility layer](https://jsr.io/docs/npm-compatibility):
  - `# install @jsr/defaude__hello-jsr --registry https://npm.jsr.io`

### SWAPI

> [/core/swapi](/core/swapi)

- The SWAPI is an API server running completely inside a service worker using [Hono](https://hono.dev)
- It allows for various operations including the `fs` route to fetch files via URL
- e.g., `# fetch /swapi/fs/home/user/hello.txt`
- e.g., `# fetch /swapi/fake/person/fullName`

### Utils

> [/utils](/utils)

- Utilities and configuration used during development

## Important Files and Directories

- `/bin/`: Built-in commands
- `/bios/`: The BIOS filesystem
- `/boot/init`: A script that runs on boot
- `/dev/`: All devices are here
- `/etc/packages`: A list of installed packages to load on boot
- `/home/`: Contains user home directories
- `/proc/`: Contains various dynamic system information
- `/root/`: The home directory for the root user
- `/usr/bin/`: Executable packages get linked here
- `/usr/lib/`: All installed packages are here
- `/var/log/kernel.log`: The kernel log

## Command Examples

```sh
ai "Despite all my rage" # use `env OPENAI_API_KEY --set sk-`
cat /var/log/kernel.log
cd /tmp
echo "Hello, world!" > hello.txt
chmod 700 hello.txt
chown user hello.txt
clear
cp /tmp/hello.txt /tmp/hi.txt
download hello.txt
edit hello.txt
env hello --set world ; env
fetch https://ipecho.net/plain > /tmp/myip.txt
fetch /xkcd-os.sixel # xterm.js includes sixel support
fetch /swapi/fs/home/user/hello.txt # fetch a file from the filesystem
fetch /swapi/fake/person/fullName # fetch a random person from the SWAPI
install jquery
install @ecmaos-apps/boilerplate
ls /dev
mkdir /tmp/zip ; cd /tmp/zip
upload
mount myuploadedzip.zip /mnt/zip -t zip
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
user add --username user
su user
video /root/video.mp4
zip /root/tmp.zip /tmp
```

## Device Examples

```sh
/dev/audio test
/dev/battery status
/dev/bluetooth scan
echo "This will error" > /dev/full
/dev/gamepad list
/dev/geo position
/dev/gpu test
/dev/hid list
/dev/midi list
echo "Goodbye" > /dev/null
/dev/presentation start https://wikipedia.org
cat /dev/random --bytes 10
/dev/sensors list
/dev/serial devices
/dev/usb list
/dev/webgpu test
cat /dev/zero --bytes 10 > /dev/null
```

Note: many device implementations are incomplete, but provide a solid starting point

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
- `/etc/packages` is a list of already installed packages to load on boot; one per line
- The env var `VITE_KERNEL_MODULES` is a list of modules to load on boot; CSV with pinned versions
- The env var `VITE_RECOMMENDED_APPS` is a list of apps to suggest to new users

## App Development

The [apps](/apps) directory in the repository contains some examples of how to develop apps, but there are many approaches you could take.

- `@ecmaos-apps/boilerplate`: A minimal boilerplate app for reference
- `@ecmaos-apps/code`: A simple code editor app using [Monaco](https://microsoft.github.io/monaco-editor/); serves as a good reference for more complex apps

Basically, your app's [bin](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin) file has a `main` (or default) function export that is passed the kernel reference and can use it to interact with the system as needed. A shebang line of `#!ecmaos:bin:app:myappname` is required at the top of the bin file to identify it as an app.

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

## Early Days

ecmaOS is currently in active development. It is not considered stable and the structure and API are very likely to change in unexpected and possibly unannounced ways until version 1.0.0. Use cautiously and at your own risk.

Things to keep in mind:

- If things go wrong or break, clear your browser cache and site data for ecmaOS
- Things have changed a lot since the tests were written, so they need to be updated and fixed
- The kernel is designed to be run in an environment with a DOM (i.e. a browser)
- Many features are only available on Chromium-based browsers, and many more behind feature flags
- There will be a lot of technical challenges to overcome, and many things will first be implemented in a non-optimal way
- Command interfaces won't match what you might be used to from a traditional Linux environment; not all commands and options are supported. Over time, Linuxish commands will be fleshed out and made to behave in a more familiar way.
- Globbing doesn't work in the terminal yet, [but is supported at the filesystem level](https://zenfs.dev/core/functions/fs.promises.glob.html)

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
