# speaker-test

`man @ecmaos/coreutils-copyleft/speaker-test`

## Synopsis

```
speaker-test [-D DEVICE] [-t sine|pink|wav] [-c CHANNELS] [-f HZ] [-r RATE] [-l LOOPS]
```

## Description

`speaker-test` 1.2.16, from the ALSA project: plays a test tone (`-t sine`), pink noise (`-t pink`, the default) or a
spoken channel name (`-t wav`) to each speaker in turn. The device is the default, the card behind the `plug` plugin
(see `aplay`); `-l 1` plays one pass and stops, otherwise it plays until interrupted.

## Examples

```
speaker-test -t sine -f 440 -c 2 -l 1
speaker-test -c 2
```

## License

GPL-2.0-or-later, with alsa-lib (LGPL-2.1-or-later) linked in. The license texts and the offer of source are in
`/usr/share/licenses/@ecmaos/coreutils-copyleft/speaker-test/`, `alsa-utils/` and `alsa-lib/`.
