# amixer

`man @ecmaos/coreutils-copyleft/amixer`

## Synopsis

```
amixer [-c CARD] [scontrols | scontents | sset CONTROL VALUE | sget CONTROL]
amixer [-c CARD] controls | contents | cset ID VALUE | cget ID
```

## Description

`amixer` 1.2.16, from the ALSA project: shows and sets the controls of the sound card's mixer, through
`/dev/snd/controlC0`. The card has four controls, as ALSA names them: `Master Playback Volume` and `Master Playback
Switch` for the speakers and `Capture Volume` and `Capture Switch` for the microphone, each with a left and a right
value, 0 to 100 for a volume, on or off for a switch. `amixer` calls the pairs `Master` and `Capture`. The speakers
follow a change at once, and the microphone's level is applied to the samples as they are recorded.

The mixer is the machine's, not a program's: a setting stays until it is changed or the page is reloaded.

## Examples

```
amixer
amixer sset Master 40%
amixer sset Master mute
amixer sset Capture 80%
amixer controls
amixer cget numid=1
```

## License

GPL-2.0-or-later, with alsa-lib (LGPL-2.1-or-later) linked in. The license texts and the offer of source are in
`/usr/share/licenses/@ecmaos/coreutils-copyleft/amixer/`, `alsa-utils/` and `alsa-lib/`.
