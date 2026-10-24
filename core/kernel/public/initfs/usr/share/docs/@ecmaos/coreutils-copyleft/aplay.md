# aplay

`man @ecmaos/coreutils-copyleft/aplay`

## Synopsis

```
aplay [OPTIONS] [FILE ...]
aplay -l
aplay -L
```

## Description

`aplay` 1.2.16, from the ALSA project: plays WAV, AU and VOC files and raw samples to the sound card. The card is the
one the audio driver offers, the browser's speakers (`/dev/snd/pcmC0D0p`, card 0, device 0, listed by `aplay -l`).
Samples go to it by the ioctls of Linux's PCM interface, `SNDRV_PCM_IOCTL_WRITEI_FRAMES` and the others, so alsa-lib
(which is linked in) talks to it exactly as it does to a card in Linux; nothing is mapped, because a program here has no
memory the device can share, and the library does the work of a mapped buffer with `SNDRV_PCM_IOCTL_SYNC_PTR`.

The default device is the card behind alsa-lib's `plug` and `mmap_emul` plugins, so a file may be in any format,
rate or channel count and is converted. `-D hw:0,0` is the card as it is: 8, 16, 24 and 32 bit integer samples and
32 bit float, one to eight channels, 8000 to 192000 Hz, and read/write access only (`-M`, memory-mapped access, needs
the default device). Only one program can have the card open at a time, as a card with one subdevice allows; another
gets `Device or resource busy`. A stream that is not fed in time is an xrun, which `aplay` reports (`-v` shows the
buffer it settled on, `--period-size` and `--buffer-size` set them).

The browser has to let the page play sound, which it does after the page has had a click or key press.

The volume is `amixer`'s: `amixer sset Master 50%`.

## Examples

```
aplay -l
aplay beep.wav
aplay -D hw:0,0 -v beep.wav
aplay -t raw -f S16_LE -r 44100 -c 2 song.raw
speaker-test -t sine -f 440 -c 2 -l 1
```

## License

GPL-2.0-or-later, with alsa-lib (LGPL-2.1-or-later) linked in. The license texts and the offer of source are in
`/usr/share/licenses/@ecmaos/coreutils-copyleft/aplay/`, `alsa-utils/` and `alsa-lib/`.
