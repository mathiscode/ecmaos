// SPDX-License-Identifier: MIT OR Apache-2.0
// v4l2grab: takes a picture from a video4linux camera with the read I/O method (see linux/videodev2.h).
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

// linux/videodev2.h, which the toolchain's headers do not have; only what is used, for a 32-bit target
struct v4l2_capability { uint8_t driver[16]; uint8_t card[32]; uint8_t bus_info[32]; uint32_t version, capabilities, device_caps, reserved[3]; };
struct v4l2_fmtdesc { uint32_t index, type, flags; uint8_t description[32]; uint32_t pixelformat, mbus_code, reserved[3]; };
struct v4l2_pix_format { uint32_t width, height, pixelformat, field, bytesperline, sizeimage, colorspace, priv, flags, ycbcr_enc, quantization, xfer_func; };
struct v4l2_format { uint32_t type; union { struct v4l2_pix_format pix; uint8_t raw_data[200]; } fmt; };
struct v4l2_frmsizeenum { uint32_t index, pixel_format, type; uint32_t width, height; uint32_t unused[4]; uint32_t reserved[2]; };
struct v4l2_streamparm { uint32_t type; struct { uint32_t capability, capturemode, numerator, denominator, extendedmode, readbuffers, reserved[4]; } capture; uint8_t pad[160]; };
#define VIDIOC_QUERYCAP _IOR('V', 0, struct v4l2_capability)
#define VIDIOC_ENUM_FMT _IOWR('V', 2, struct v4l2_fmtdesc)
#define VIDIOC_G_FMT _IOWR('V', 4, struct v4l2_format)
#define VIDIOC_S_FMT _IOWR('V', 5, struct v4l2_format)
#define VIDIOC_S_PARM _IOWR('V', 22, struct v4l2_streamparm)
#define VIDIOC_ENUM_FRAMESIZES _IOWR('V', 74, struct v4l2_frmsizeenum)
#define V4L2_BUF_TYPE_VIDEO_CAPTURE 1
#define V4L2_CAP_READWRITE 0x01000000
#define V4L2_CAP_VIDEO_CAPTURE 1
#define FOURCC(a, b, c, d) ((uint32_t)(a) | ((uint32_t)(b) << 8) | ((uint32_t)(c) << 16) | ((uint32_t)(d) << 24))
#define PIX_YUYV FOURCC('Y', 'U', 'Y', 'V')
#define PIX_MJPG FOURCC('M', 'J', 'P', 'G')

static void usage(void) {
  fprintf(stderr, "usage: v4l2grab [-i] [-d DEVICE] [-f yuyv|mjpg] [-s WIDTHxHEIGHT] [-r FPS] [-n COUNT] [-o FILE]\n");
  exit(2);
}

static uint8_t clamp(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// a YUYV picture as a binary PPM
static void write_ppm(FILE *out, const uint8_t *yuyv, int w, int h) {
  fprintf(out, "P6\n%d %d\n255\n", w, h);
  for (int i = 0; i + 3 < w * h * 2; i += 4) {
    int u = yuyv[i + 1] - 128, v = yuyv[i + 3] - 128;
    for (int k = 0; k < 2; k++) {
      int y = yuyv[i + 2 * k];
      fputc(clamp(y + (int)(1.402 * v)), out);
      fputc(clamp(y - (int)(0.344136 * u + 0.714136 * v)), out);
      fputc(clamp(y + (int)(1.772 * u)), out);
    }
  }
}

int main(int argc, char **argv) {
  const char *device = "/dev/video0", *output = "-", *format = "yuyv";
  int info = 0, count = 1, width = 0, height = 0, rate = 0, c;
  while ((c = getopt(argc, argv, "id:f:s:r:n:o:")) != -1) {
    switch (c) {
      case 'i': info = 1; break;
      case 'd': device = optarg; break;
      case 'f': format = optarg; break;
      case 's': if (sscanf(optarg, "%dx%d", &width, &height) != 2) usage(); break;
      case 'r': rate = atoi(optarg); break;
      case 'n': count = atoi(optarg); break;
      case 'o': output = optarg; break;
      default: usage();
    }
  }
  uint32_t fourcc = !strcmp(format, "mjpg") ? PIX_MJPG : !strcmp(format, "yuyv") ? PIX_YUYV : 0;
  if (!fourcc || count < 1) usage();

  int fd = open(device, O_RDWR);
  if (fd < 0) { fprintf(stderr, "v4l2grab: %s: %s\n", device, strerror(errno)); return 1; }
  struct v4l2_capability cap;
  if (ioctl(fd, VIDIOC_QUERYCAP, &cap) < 0) { fprintf(stderr, "v4l2grab: %s: not a video device (%s)\n", device, strerror(errno)); return 1; }
  if (!(cap.device_caps & V4L2_CAP_VIDEO_CAPTURE) || !(cap.device_caps & V4L2_CAP_READWRITE)) { fprintf(stderr, "v4l2grab: %s cannot capture with read\n", device); return 1; }

  if (info) {
    printf("%s: %s (%s, %s)\n", device, cap.card, cap.driver, cap.bus_info);
    for (uint32_t i = 0;; i++) {
      struct v4l2_fmtdesc desc = { .index = i, .type = V4L2_BUF_TYPE_VIDEO_CAPTURE };
      if (ioctl(fd, VIDIOC_ENUM_FMT, &desc) < 0) break;
      printf("  format %.4s  %s\n", (char *)&desc.pixelformat, desc.description);
      for (uint32_t j = 0;; j++) {
        struct v4l2_frmsizeenum size = { .index = j, .pixel_format = desc.pixelformat };
        if (ioctl(fd, VIDIOC_ENUM_FRAMESIZES, &size) < 0) break;
        printf("    %ux%u\n", size.width, size.height);
      }
    }
    return 0;
  }

  struct v4l2_format fmt;
  memset(&fmt, 0, sizeof fmt);
  fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
  if (ioctl(fd, VIDIOC_G_FMT, &fmt) < 0) { perror("v4l2grab: VIDIOC_G_FMT"); return 1; }
  fmt.fmt.pix.pixelformat = fourcc;
  if (width) { fmt.fmt.pix.width = width; fmt.fmt.pix.height = height; }
  if (ioctl(fd, VIDIOC_S_FMT, &fmt) < 0) { perror("v4l2grab: VIDIOC_S_FMT"); return 1; }
  if (fmt.fmt.pix.pixelformat != fourcc) { fprintf(stderr, "v4l2grab: %s is not offered\n", format); return 1; }
  if (rate > 0) {
    struct v4l2_streamparm parm;
    memset(&parm, 0, sizeof parm);
    parm.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    parm.capture.numerator = 1;
    parm.capture.denominator = rate;
    if (ioctl(fd, VIDIOC_S_PARM, &parm) < 0) { perror("v4l2grab: VIDIOC_S_PARM"); return 1; }
  }
  fprintf(stderr, "v4l2grab: %ux%u %.4s\n", fmt.fmt.pix.width, fmt.fmt.pix.height, (char *)&fmt.fmt.pix.pixelformat);

  size_t size = fmt.fmt.pix.sizeimage;
  uint8_t *frame = malloc(size);
  ssize_t got = 0;
  for (int i = 0; i < count; i++) {
    got = read(fd, frame, size);
    if (got < 0) { perror("v4l2grab: read"); return 1; }
  }
  FILE *out = strcmp(output, "-") ? fopen(output, "wb") : stdout;
  if (!out) { fprintf(stderr, "v4l2grab: %s: %s\n", output, strerror(errno)); return 1; }
  if (fourcc == PIX_YUYV) write_ppm(out, frame, fmt.fmt.pix.width, fmt.fmt.pix.height);
  else fwrite(frame, 1, got, out);
  if (out != stdout) fclose(out);
  return 0;
}
