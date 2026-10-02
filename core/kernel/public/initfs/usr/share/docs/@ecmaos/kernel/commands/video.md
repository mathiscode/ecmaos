# video

`man @ecmaos/kernel/commands/video`

## Synopsis

```
video [OPTIONS] [FILE...]
```

## Description

Play a video file in a window.

## Options

```
  --help                   display this help and exit
  --no-autoplay            don't start playing automatically
  --no-controls            hide video controls
  --loop                   loop the video
  --muted                  start muted
  --fullscreen             open in fullscreen mode
  --width <width>          set window width (default: video width or screen width)
  --height <height>        set window height (default: video height or screen height)

Examples:
  video movie.mp4                    play a video file
  video --loop clip.mp4             play a video in a loop
  video --no-autoplay video.mp4     load video without auto-playing
  video --fullscreen movie.mp4      play video in fullscreen mode
  video video1.mp4 video2.mp4       play multiple videos
```

## See also

`video --help`
