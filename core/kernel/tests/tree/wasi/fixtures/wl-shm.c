/* A hand-written Wayland client for testing wlcomp: binds the globals, opens an xdg toplevel with a shared-memory
 * buffer and animates it for a few frames. Usage: wl-shm [FRAMES] [WIDTH] [HEIGHT] [HOLD_MS] */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int sock;
static uint8_t out[4096];
static size_t on;

static void begin(uint32_t id, uint32_t op) { on = 8; memcpy(out, &id, 4); memcpy(out + 4, &op, 4); }
static void u32(uint32_t v) { memcpy(out + on, &v, 4); on += 4; }
static void str(const char *s) { uint32_t n = (uint32_t)strlen(s) + 1; u32(n); memcpy(out + on, s, n); memset(out + on + n, 0, ((n + 3) & ~3u) - n); on += (n + 3) & ~3u; }
static void finish(int fd) {
  uint32_t head = (uint32_t)(on << 16) | out[4];
  memcpy(out + 4, &head, 4);
  struct iovec io = { out, on };
  char control[CMSG_SPACE(sizeof(int))];
  struct msghdr m;
  memset(&m, 0, sizeof m);
  m.msg_iov = &io; m.msg_iovlen = 1;
  if (fd >= 0) {
    memset(control, 0, sizeof control);
    m.msg_control = control; m.msg_controllen = sizeof control;
    struct cmsghdr *c = CMSG_FIRSTHDR(&m);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &fd, sizeof(int));
  }
  if (sendmsg(sock, &m, 0) < 0) { printf("send failed %d\n", errno); exit(2); }
}

static uint8_t in[65536];
static size_t inn;
static uint32_t shm_name, comp_name, wm_name;
static int configured, got_sync, frame_done, closed, error_seen;
static uint32_t config_serial, sync_id = 3, frame_id;

static void handle(uint32_t id, uint32_t op, const uint8_t *p, size_t len) {
  if (id == 1 && op == 0) { uint32_t obj, code; memcpy(&obj, p, 4); memcpy(&code, p + 4, 4); printf("error object=%u code=%u %s\n", obj, code, p + 12); error_seen = 1; }
  else if (id == 2 && op == 0) {
    uint32_t name, slen; memcpy(&name, p, 4); memcpy(&slen, p + 4, 4);
    const char *iface = (const char *)p + 8;
    if (!strcmp(iface, "wl_shm")) shm_name = name;
    if (!strcmp(iface, "wl_compositor")) comp_name = name;
    if (!strcmp(iface, "xdg_wm_base")) wm_name = name;
    printf("global %u %s\n", name, iface);
  }
  else if (id == sync_id && op == 0) got_sync = 1;
  else if (id == 6 && op == 0) { uint32_t serial; memcpy(&serial, p, 4); begin(6, 3); u32(serial); finish(-1); }
  else if (id == 8 && op == 0) { memcpy(&config_serial, p, 4); configured = 1; }
  else if (id == 9 && op == 1) closed = 1;
  else if (id == frame_id && frame_id && op == 0) frame_done = 1;
  (void)len;
}

static void pump(int *flag) {
  for (;;) {
    size_t at = 0;
    while (inn - at >= 8) {
      uint32_t id, head; memcpy(&id, in + at, 4); memcpy(&head, in + at + 4, 4);
      uint32_t size = head >> 16, op = head & 0xffff;
      if (inn - at < size) break;
      handle(id, op, in + at + 8, size - 8);
      at += size;
    }
    memmove(in, in + at, inn - at); inn -= at;
    if (*flag || closed || error_seen) return;
    ssize_t n = recv(sock, in + inn, sizeof in - inn, 0);
    if (n <= 0) { printf("disconnected\n"); exit(3); }
    inn += (size_t)n;
  }
}

static void roundtrip(void) { sync_id++; got_sync = 0; begin(1, 0); u32(sync_id); finish(-1); pump(&got_sync); }

int main(int argc, char **argv) {
  int frames = argc > 1 ? atoi(argv[1]) : 3;
  int w = argc > 2 ? atoi(argv[2]) : 160, h = argc > 3 ? atoi(argv[3]) : 100;
  int hold = argc > 4 ? atoi(argv[4]) : 0;
  const char *dir = getenv("XDG_RUNTIME_DIR"), *name = getenv("WAYLAND_DISPLAY");
  if (!dir || !name) { printf("no XDG_RUNTIME_DIR or WAYLAND_DISPLAY\n"); return 1; }
  struct sockaddr_un addr; memset(&addr, 0, sizeof addr); addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof addr.sun_path, "%s/%s", dir, name);
  sock = socket(AF_UNIX, SOCK_STREAM, 0);
  if (connect(sock, (struct sockaddr *)&addr, sizeof addr) < 0) { printf("connect failed %d\n", errno); return 1; }
  printf("connected\n");

  begin(1, 1); u32(2); finish(-1);   /* get_registry -> 2 */
  roundtrip();
  if (!shm_name || !comp_name || !wm_name) { printf("missing globals\n"); return 1; }
  begin(2, 0); u32(comp_name); str("wl_compositor"); u32(4); u32(4); finish(-1);   /* compositor = 4 */
  begin(2, 0); u32(shm_name); str("wl_shm"); u32(1); u32(5); finish(-1);           /* shm = 5 */
  begin(2, 0); u32(wm_name); str("xdg_wm_base"); u32(2); u32(6); finish(-1);       /* wm_base = 6 */
  begin(4, 0); u32(7); finish(-1);          /* surface = 7 */
  begin(6, 2); u32(8); u32(7); finish(-1);  /* xdg_surface = 8 */
  begin(8, 1); u32(9); finish(-1);          /* toplevel = 9 */
  begin(9, 2); str("wl-shm"); finish(-1);   /* title */
  begin(7, 6); finish(-1);                  /* commit */
  pump(&configured);
  if (!configured) { printf("not configured\n"); return 1; }
  printf("configured\n");
  begin(8, 4); u32(config_serial); finish(-1);   /* ack_configure */

  char path[256];
  snprintf(path, sizeof path, "%s/wl-shm-XXXXXX", dir);
  int fd = mkstemp(path);
  if (fd < 0) { printf("mkstemp failed %d\n", errno); return 1; }
  unlink(path);
  size_t size = (size_t)w * h * 4;
  if (ftruncate(fd, (off_t)size) < 0) { printf("ftruncate failed\n"); return 1; }
  uint32_t *px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (px == MAP_FAILED) { printf("mmap failed %d\n", errno); return 1; }
  begin(5, 0); u32(10); u32((uint32_t)size); finish(fd);                              /* pool = 10 */
  begin(10, 0); u32(11); u32(0); u32((uint32_t)w); u32((uint32_t)h); u32((uint32_t)w * 4); u32(1); finish(-1); /* buffer = 11, xrgb8888 */

  for (int i = 0; i < frames; i++) {
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++)
      px[y * w + x] = (uint32_t)(((x * 255 / w) << 16) | ((y * 255 / h) << 8) | ((i * 60) & 255));
    frame_id = 12 + (uint32_t)i;
    frame_done = 0;
    begin(7, 1); u32(11); u32(0); u32(0); finish(-1);      /* attach */
    begin(7, 3); u32(frame_id); finish(-1);               /* frame */
    begin(7, 6); finish(-1);                              /* commit */
    pump(&frame_done);
    if (closed || error_seen) break;
    printf("frame %d\n", i);
  }
  printf(closed ? "closed\n" : "done\n");
  fflush(stdout);
  /* stay up, so the window can be looked at; a close request from the compositor ends it */
  for (int waited = 0; waited < hold && !closed; waited += 50) {
    struct pollfd p = { sock, POLLIN, 0 };
    if (poll(&p, 1, 50) > 0) {
      ssize_t n = recv(sock, in + inn, sizeof in - inn, 0);
      if (n <= 0) break;
      inn += (size_t)n;
      int once = 1;
      pump(&once);
    }
  }
  printf(closed ? "closed\n" : "exit\n");
  return 0;
}
