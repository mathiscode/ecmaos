# view

`man @ecmaos/kernel/commands/view`

## Synopsis

```
view [OPTIONS] [FILE...]
```

## Description

View files in a new window. Supports PDF, markdown, JSON, images, audio, and video files.

## Options

```
  --help                   display this help and exit
  
Audio/Video Options (for audio and video files):
  --no-autoplay            don't start playing automatically
  --loop                   loop the media
  --muted                  start muted
  --volume <0-100>         set volume (0-100, default: 100, audio only)
  --no-controls            hide video controls (video only)
  --fullscreen             open in fullscreen mode (video only)
  --width <width>          set window width (video only)
  --height <height>        set window height (video only)
  --quiet                  play without opening a window (audio only, background playback)

Examples:
  view document.pdf                    view a PDF file
  view README.md                       view a markdown file
  view data.json                       view a JSON file
  view image.png                       view an image
  view song.mp3                        view/play an audio file
  view movie.mp4                       view/play a video file
  view --loop music.mp3                play audio in a loop
  view --no-autoplay video.mp4         load video without auto-playing
  view --volume 50 track.mp3           play at 50% volume
  view --fullscreen movie.mp4          play video in fullscreen mode
```

## See also

`view --help`
