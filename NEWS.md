# News

> This file is used by the `@ecmaos-apps/news` app to update the user on the latest news.
> This is more curated than changesets - it's more for end users and critical updates.
> `install @ecmaos-apps/news` and `news` to see the latest news.

---

## 1.0.0

- ecmaOS 1.0.0 is here! Every command now runs through a real, worker-hosted `execve` - the old in-process `ProcessManager` is gone for good. Programs have real pids, signals, exit codes, sessions and controlling terminals.
- `/sbin/init` is pid 1 and runs `/etc/inittab`, with a `getty` login on each of the eight terminals, runlevels (`telinit`, `runlevel`), and `reboot`, `halt` and `poweroff` that stop the system in order.
- Real users: your programs run as you, `su` and `sudo` are setuid programs (`/etc/sudoers` with aliases), `/etc/passwd`, `/etc/group` and `/etc/shadow` are in the Linux format (existing installs are migrated on boot), and there are `useradd`, `usermod`, `groupadd`, `visudo` and friends, `/etc/skel`, and storage quotas.
- The shell grew up, and there are two of them: the built-in one and `/bin/ecmash`, both checked against bash. Heredocs, here-strings, `[[ ]]`, indexed and associative arrays, functions, `case`, C-style `for`, arithmetic, brace expansion, process substitution, `trap` for every signal, job control, aliases, completion, `~/.bashrc` and the other startup files, and a readline line editor with history. `/bin/sh` and `/bin/bash` point at them.
- Coreutils match GNU: more than 380 commands are compared against real GNU output, and there are new ones (`xargs`, `timeout`, `watch`, `top`, `pgrep`, `strace`, `fsck`, `df`, `dmesg`, `fastfetch` and more). `ls` and `grep` do `--color`, and `man` has a page for nearly everything.
- Real programs built to WebAssembly: Vim 9.1, nano, GNU make, ed, sqlite3, jq, Lua, MicroPython, QuickJS, bc, tree, ncdu, mg, the compressors (bzip2, xz, zstd, brotli, lz4), and toybox's `ps` (`ps aux` works), `htop`, `perl` (5.44, with its core modules), `lsof`, `lsusb`, `lspci`, `vmstat`, `netstat` and `sysctl`, which read the `/proc` that ecmaOS now has (`/proc/stat`, `loadavg`, `<pid>/stat` and `net/`). Copyleft programs ship with their source.
- A desktop: `startx` gives a taskbar, a launcher, terminal windows and workspaces. Below it are Linux framebuffers, evdev input, a Wayland compositor (`wlcomp`), and SDL 3 with OpenGL ES on WebGL2, enough to play `doom` (bring a WAD; Freedoom works).
- Devices are files: `/dev/usb<N>`, `/dev/ble<N>`, `/dev/hidraw<N>`, `/dev/midi<N>`, `/dev/dsp`, the sensors, pseudo-terminals and more, each keeping its number across boots.
- Serial ports are where Linux puts them: `/dev/ttyACM<N>` for a board (Arduino, Raspberry Pi Pico, ESP32), `/dev/ttyUSB<N>` behind a USB-serial chip, `/dev/rfcomm<N>` over Bluetooth, and `/dev/serial/by-id`. They are real terminals with real settings, so `microcom -s 115200 /dev/ttyACM0`, `screen /dev/ttyACM0 115200` and `stty -F /dev/ttyACM0 115200 raw` work, and a board plugged in or unplugged comes and goes as it does on Linux. `/dev/rtc0` (`hwclock`) and `/dev/hwrng` are the browser's clock and random source, and `/sys` attributes can be read. Gamepads are Linux gamepads: `/dev/input/event<N>` and `/dev/input/js<N>` with Linux's codes and rumble, coming and going with the pad, so SDL uses its own Linux driver and `evtest` shows them. `lsblk` reads the block layer in `/sys/block`, `lsusb` lists the serial, HID and WebUSB devices the page has been granted (`/sys/bus/usb/devices`), and `lspci` reads `/sys/bus/pci`, which is there and empty.
- HID devices speak hidraw: `/dev/hidraw<N>` answers Linux's ioctls (name, ids, report descriptor, feature reports) and reads one report at a time, and `hidinfo` lists them. A device you allow, plug in or unplug gets its node, or loses it, without a reboot.
- Sound is ALSA: `/dev/snd/pcmC0D0p` (the speakers), `pcmC0D0c` (the microphone) and `controlC0` answer Linux's PCM and control ioctls, so alsa-lib and the real `aplay`, `arecord`, `amixer` and `speaker-test` run on them (`aplay -l`, `aplay song.wav`, `arecord -d 5 voice.wav`, `amixer sset Master 40%`), with format, rate and channel conversion through alsa-lib's `plug`. The OSS nodes (`/dev/dsp`, `/dev/dsp1`) are still there.
- Cameras are video4linux devices: `/dev/video<N>` answers the V4L2 ioctls for read I/O (formats, sizes, frame rate) and a read gives one whole frame, YUYV or Motion-JPEG; `v4l2grab` takes a picture. A camera plugged in or unplugged gets or loses its node at once.
- Networking: POSIX sockets (Unix, IPv4, IPv6, UDP, descriptor passing) between programs, and a gateway (`gateway up`) through an `ecmaos --listen` machine for real TCP and UDP. `ss`, `ip`, `host`, `dig`, `nslookup` and `ping` report the machine honestly: one interface (`lo`), the listening sockets, names resolved by the gateway, and a `ping` that times a TCP connect, since a browser cannot send ICMP.
- ecmaOS runs in Node too (`@ecmaos/node`): a machine in a terminal, kept in a SQLite file. With `ecmaos --listen`, other machines can log in, mount its folders, attach its devices, and show its windows on a browser page (`?screen=`).
- One tab per machine: a second tab offers to take over, open a console on the running machine (`?display=N`) or start a guest session, and `?machine=NAME` runs a separate machine.
- The browser is part of the machine: `notify-send`, `xclip`, `say` and `xdg-open`.
- Clicking a command link in terminal output now asks you to confirm before it runs.
- A failed boot now leaves you with a readable error instead of a stuck spinner, and a page without cross-origin isolation says which headers to set.
- Toolchain upgraded across the board: Vite 8, TypeScript 7, ESLint 10, vitest 5.

## 2025-12-31

- Development is picking back up!
- This project could really use some issues and PRs to move the needle forward, help out if you can!

## 2024-12-13

- Added `@ecmaos-apps/news` to pull ecmaos news
