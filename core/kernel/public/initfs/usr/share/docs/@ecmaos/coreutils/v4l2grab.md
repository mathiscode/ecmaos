# v4l2grab

`man @ecmaos/coreutils/v4l2grab`

## Synopsis

```
v4l2grab [-i] [-d DEVICE] [-f yuyv|mjpg] [-s WIDTHxHEIGHT] [-r FPS] [-n COUNT] [-o FILE]
```

## Description

Takes a picture from a video4linux camera (`/dev/video<n>`, one for each camera the browser lists) with the read I/O method: it sets the format (`VIDIOC_S_FMT`), optionally the frame rate (`VIDIOC_S_PARM`), reads `COUNT` frames (the first ones are often dark) and writes the last. The first use asks the browser for the camera, which the user has to allow.

`-i` prints what the camera is (`VIDIOC_QUERYCAP`), its formats (`VIDIOC_ENUM_FMT`) and sizes (`VIDIOC_ENUM_FRAMESIZES`) and takes no picture. `-d` names the device (default `/dev/video0`), `-f` the pixel format (`yuyv`, the default, or `mjpg`), `-s` the size the camera is asked for and `-r` the rate. `-o` names the file; the default is standard output.

A `yuyv` picture is written as a binary PPM; an `mjpg` picture is the JPEG as the camera gave it. A camera that cannot give the size asked for gives the nearest, and the size actually chosen is printed on standard error.

Streaming with buffers (`VIDIOC_REQBUFS`, `QBUF`, `DQBUF`) is not offered, as it needs memory shared between the program and the device; a program that has no read fallback cannot use the camera yet.

## Examples

```
v4l2grab -i
v4l2grab -n 5 -o /tmp/picture.ppm
v4l2grab -f mjpg -s 1280x720 -n 3 -o /tmp/picture.jpg
```

## License

MIT OR Apache-2.0.
