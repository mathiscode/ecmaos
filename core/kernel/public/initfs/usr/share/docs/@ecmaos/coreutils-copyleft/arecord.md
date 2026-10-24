# arecord

`man @ecmaos/coreutils-copyleft/arecord`

## Synopsis

```
arecord [OPTIONS] [FILE]
arecord -l
```

## Description

`arecord` 1.2.16, from the ALSA project: records from the sound card to a WAV file, or raw samples. The card is the one
the audio driver offers, the browser's microphone (`/dev/snd/pcmC0D0c`, card 0, device 0, listed by `arecord -l`). It is
the same program as `aplay`, run under the name `arecord`; see `aplay` for how the card is reached.

The browser asks the user for permission to use the microphone the first time a recording starts, and the microphone
is let go when the recording ends. The stream is as the library asks for it: `-r` is the sample rate, `-f` the format
and `-c` the number of channels, converted from what the browser gives. `-d SECONDS` stops after that long, or
`^C` stops it and finishes the file. A recording that is not read fast enough overflows its buffer, which `arecord` reports (`overrun!!!`) before it
goes on. `amixer sset Capture 50%` sets the level.

## Examples

```
arecord -d 5 -r 16000 -f S16_LE voice.wav
arecord -l
arecord -d 3 -f cd - | aplay -
```

## License

GPL-2.0-or-later, with alsa-lib (LGPL-2.1-or-later) linked in. The license texts and the offer of source are in
`/usr/share/licenses/@ecmaos/coreutils-copyleft/arecord/`, `alsa-utils/` and `alsa-lib/`.
