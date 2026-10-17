/* mmap on a temp file and on a framebuffer, with the coherence the shim keeps at syscalls. The framebuffer is the node named by $FB. */
#define _GNU_SOURCE
#include <stdio.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <linux/fb.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>
#include <stdint.h>

static int check(const char *what, int ok) { if (ok) printf("%s: ok\n", what); else printf("%s: FAIL (errno %d)\n", what, errno); return ok ? 0 : 1; }

int main(void) {
  int bad = 0;

  // an unlinked temp file (what wl_shm clients use without memfd), mapped shared, written through the pointer, read back through the descriptor
  char tmpl[] = "/tmp/spike-XXXXXX";
  int m = mkstemp(tmpl);
  bad += check("mkstemp", m >= 0);
  if (m >= 0) bad += check("unlink while open", unlink(tmpl) == 0);
  if (m >= 0) {
    bad += check("ftruncate", ftruncate(m, 8192) == 0);
    char *p = mmap(NULL, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, m, 0);
    bad += check("mmap temp file", p != MAP_FAILED);
    if (p != MAP_FAILED) {
      strcpy(p, "through the pointer");
      msync(p, 8192, MS_SYNC);
      char buf[32] = {0};
      pread(m, buf, 19, 0);
      bad += check("pointer write visible to pread", strcmp(buf, "through the pointer") == 0);
      pwrite(m, "from the fd", 11, 100);
      msync(p, 8192, MS_INVALIDATE);
      bad += check("fd write visible through the pointer after msync", memcmp(p + 100, "from the fd", 11) == 0);
      bad += check("munmap", munmap(p, 8192) == 0);
    }
    close(m);
  }

  // a framebuffer: map it and draw
  int fb = open(getenv("FB") ? getenv("FB") : "/dev/fb0", O_RDWR);
  if (fb >= 0) {
    struct fb_var_screeninfo v;
    struct fb_fix_screeninfo f;
    bad += check("FBIOGET_VSCREENINFO", ioctl(fb, FBIOGET_VSCREENINFO, &v) == 0);
    bad += check("FBIOGET_FSCREENINFO", ioctl(fb, FBIOGET_FSCREENINFO, &f) == 0);
    printf("%ux%u %ubpp stride %u len %u\n", v.xres, v.yres, v.bits_per_pixel, f.line_length, f.smem_len);
    uint8_t *px = mmap(NULL, f.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fb, 0);
    bad += check("mmap fb", px != MAP_FAILED);
    if (px != MAP_FAILED) {
      for (unsigned i = 0; i < f.smem_len; i += 4) { px[i] = 0; px[i + 1] = 0; px[i + 2] = 200; px[i + 3] = 0; }
      // with NOSYNC the program only sleeps, as one drawing frames does: the shim finds the changes when the clock is read
      if (!getenv("NOSYNC")) msync(px, f.smem_len, MS_SYNC);
      usleep(50000);
      munmap(px, f.smem_len);
    }
    close(fb);
  } else {
    printf("no framebuffer: %d\n", errno);
  }
  printf("%s\n", bad ? "FAILED" : "all ok");
  return bad;
}
