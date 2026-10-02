# play

`man @ecmaos/kernel/commands/play`

## Synopsis

```
play [OPTIONS] [FILE...]
```

## Description

Play an audio file.

## Options

```
  --help                   display this help and exit
  --no-autoplay            don't start playing automatically
  --loop                   loop the audio
  --muted                  start muted
  --volume <0-100>         set volume (0-100, default: 100)
  --quiet                  play without opening a window (background playback)

Examples:
  play song.mp3                    play an audio file
  play --loop music.mp3           play audio in a loop
  play --no-autoplay audio.mp3    load audio without auto-playing
  play --volume 50 track.mp3      play at 50% volume
  play --quiet background.mp3      play audio in background
  play song1.mp3 song2.mp3        play multiple audio files
```

## See also

`play --help`
