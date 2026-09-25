---
"@ecmaos/kernel": major
"@ecmaos/types": major
"@ecmaos/coreutils": major
"@ecmaos-devices/audio": minor
"@ecmaos-devices/battery": minor
"@ecmaos-devices/bluetooth": minor
"@ecmaos-devices/echo": minor
"@ecmaos-devices/gamepad": minor
"@ecmaos-devices/geo": minor
"@ecmaos-devices/gpu": minor
"@ecmaos-devices/hid": minor
"@ecmaos-devices/midi": minor
"@ecmaos-devices/presentation": minor
"@ecmaos-devices/sensors": minor
"@ecmaos-devices/serial": minor
"@ecmaos-devices/tty": minor
"@ecmaos-devices/usb": minor
"@ecmaos-devices/webgl": minor
---

## ecmaOS 1.0.0

Every command now runs through a real `execve`: the legacy `Process`/`FDTable`
classes and `ProcessManager` are gone, DOM apps run under `/bin/app`, and the
shell implements every construct it previously only parsed (`<<` heredocs,
`<<<` here-strings, `[[ ]]`, indexed arrays, `${PIPESTATUS[@]}`, `trap`).

Breaking changes:

- `/etc/passwd` moved to the real 7-field format
  (`name:x:uid:gid:gecos:home:shell`); supplementary groups moved to a new
  `/etc/group`. A boot-time migration converts an existing 0.x/1.0-pre
  filesystem automatically.
- The dead `FDTable`/`Process`/`ProcessEvents`/`Process*Event`/`ProcessStatus`
  types are removed from `@ecmaos/types`. `ProcessEntryParams.instance` is
  retyped to the real execve shim shape (`open`/`exit`/`keepAlive`/
  `onDispose`) `presenters/app.ts` actually uses.
- `@webcontainer/api` and `modelfusion` are no longer dependencies.
- The 104 meta-only command stubs in `@ecmaos/coreutils` are gone (kept:
  `false`/`test`/`true`, still used by the legacy command shim).

Every browser-API device (audio, battery, bluetooth, echo, gamepad, geo, gpu,
hid, midi, presentation, sensors, serial, tty, usb, webgl) gets a minor bump:
their `package.json` `exports` now point at their built `dist/index.js`
instead of raw `src/index.ts`, they declare `@zenfs/linux` (which they
already imported, undeclared) as a real dependency, and `@zenfs/core` is
aligned to `^2.7.6`.

Also in this release: clickable `ecmaos://` links in terminal output now ask
for confirmation before running; a failed boot leaves an honest UI instead of
a stuck spinner; password validation is enforced; `free`, three missing
`/proc` entries, and per-command man pages were added; the toolchain moved to
Vite 8, vitest 5, ESLint 10 flat config, and TypeScript 7; CI now lints and
tests every package via turbo, not just the kernel.

See `NEWS.md` for the user-facing summary and `.docs/overhaul/STATUS_04.md`
(local, gitignored) for the full engineering record.
