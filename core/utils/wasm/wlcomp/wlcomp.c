/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/*
 * wlcomp: a small Wayland compositor for ecmaOS.
 *
 * It listens on $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY and speaks the wire protocol by hand (no libwayland): wl_compositor,
 * wl_shm, xdg-shell (toplevels), wl_output, wl_seat and cursor-shape-v1 (a named cursor, or none, becomes the window's
 * CSS cursor). Each toplevel gets a window made by `fbwin`, and what the client commits is copied from its shm pool into that window's /dev/fbN. Pools are read with pread(), so a client
 * that maps its pool shared (a file in the runtime directory, or memfd) is seen at each commit.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define MAX_CLIENTS 16
#define MAX_OBJECTS 8192
#define MAX_FDS 32
#define INBUF 65536

enum type {
  T_NONE, T_DISPLAY, T_REGISTRY, T_CALLBACK, T_COMPOSITOR, T_REGION, T_SHM, T_POOL, T_BUFFER, T_SURFACE,
  T_WMBASE, T_XSURFACE, T_TOPLEVEL, T_POSITIONER, T_OUTPUT, T_SEAT, T_POINTER, T_KEYBOARD, T_CSMGR, T_CSDEV
};

enum global { G_COMPOSITOR = 1, G_SHM, G_WMBASE, G_OUTPUT, G_SEAT, G_CURSORSHAPE };

struct client;

struct pool { int fd; uint32_t size; int refs; };
struct buffer { struct pool *pool; uint32_t offset, width, height, stride, format; };

struct window {
  int index;       /* N of /dev/fbN, or -1 */
  int fd;
  int pid;         /* of the fbwin that owns the window */
  uint32_t width, height;
  int input;       /* the window's evdev node, or -1 */
};

struct surface {
  struct client *client;
  uint32_t id;
  struct buffer *attached;   /* pending, applied at commit */
  int has_attach;
  uint32_t frames[16];       /* pending frame callbacks */
  int nframes;
  struct buffer *buffer;     /* current */
  uint32_t damage_y0, damage_y1;   /* rows damaged since the last commit (none when y1 <= y0) */
  int drawn_w, drawn_h;      /* the size of what the window last got */
  uint32_t xsurface;         /* xdg_surface id, 0 if none */
  uint32_t toplevel;         /* xdg_toplevel id, 0 if none */
  int configured, acked, mapped;
  uint32_t serial;
  char title[128];
  struct window win;
  /* input state */
  int pointer_in, keyboard_in;
  int px, py, moved;                 /* pointer, in window pixels */
  uint8_t down[96];                  /* keys held, as a bit set over Linux key codes (0..767 is too wide; 0..255 used) */
  uint32_t mods_depressed, mods_locked;
  struct { uint16_t type, code; int32_t value; } batch[16];
  int nbatch;
  unsigned char pending[24];
  int npending;
};

struct obj { uint8_t type, version; void *data; };

struct client {
  int fd;
  int fds[MAX_FDS];
  int nfds;
  uint8_t in[INBUF];
  size_t inlen;
  struct obj objs[MAX_OBJECTS];
  int alive;
  uint32_t pointer, keyboard;   /* the wl_pointer and wl_keyboard objects, 0 if none */
};

struct due { struct client *client; uint32_t id; };

static struct client *clients[MAX_CLIENTS];
static struct due due[256];
static int ndue;
static struct surface *wins[64];
static uint32_t serial_counter = 1;
static int debug;
static uint32_t now_ms(void);
#define LOG(...) do { if (debug) { fprintf(stderr, "[%u] wlcomp: ", now_ms()); fprintf(stderr, __VA_ARGS__); fputc(10, stderr); } } while (0)
static int next_window;
static char runtime[256];
static const int screen_w = 1024, screen_h = 768;

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

/* ---- wire out ---- */

struct msg { uint8_t b[4096]; size_t n; };

static void m_start(struct msg *m, uint32_t id, uint32_t opcode) {
  m->n = 8;
  memcpy(m->b, &id, 4);
  memcpy(m->b + 4, &opcode, 4);
}
static void m_u32(struct msg *m, uint32_t v) { memcpy(m->b + m->n, &v, 4); m->n += 4; }
static void m_str(struct msg *m, const char *s) {
  uint32_t len = (uint32_t)strlen(s) + 1;
  m_u32(m, len);
  memcpy(m->b + m->n, s, len);
  memset(m->b + m->n + len, 0, ((len + 3) & ~3u) - len);
  m->n += (len + 3) & ~3u;
}
static void m_array(struct msg *m, const void *p, uint32_t len) {
  m_u32(m, len);
  memcpy(m->b + m->n, p, len);
  memset(m->b + m->n + len, 0, ((len + 3) & ~3u) - len);
  m->n += (len + 3) & ~3u;
}
static int send_fd = -1;
static void m_send(struct client *c, struct msg *m) {
  uint32_t head = (uint32_t)(m->n << 16) | (m->b[4] | (m->b[5] << 8));
  memcpy(m->b + 4, &head, 4);
  size_t at = 0;
  while (at < m->n && c->alive) {
    ssize_t w;
    if (send_fd >= 0 && at == 0) {
      char control[CMSG_SPACE(sizeof(int))];
      struct iovec io = { m->b, m->n };
      struct msghdr mh;
      memset(&mh, 0, sizeof mh);
      memset(control, 0, sizeof control);
      mh.msg_iov = &io; mh.msg_iovlen = 1;
      mh.msg_control = control; mh.msg_controllen = sizeof control;
      struct cmsghdr *ch = CMSG_FIRSTHDR(&mh);
      ch->cmsg_level = SOL_SOCKET; ch->cmsg_type = SCM_RIGHTS; ch->cmsg_len = CMSG_LEN(sizeof(int));
      memcpy(CMSG_DATA(ch), &send_fd, sizeof(int));
      w = sendmsg(c->fd, &mh, 0);
      send_fd = -1;
    } else w = send(c->fd, m->b + at, m->n - at, 0);
    if (w < 0) {
      if (errno == EAGAIN || errno == EINTR) { usleep(1000); continue; }
      c->alive = 0;
      return;
    }
    at += (size_t)w;
  }
}

static void ev(struct client *c, uint32_t id, uint32_t opcode, const char *fmt, ...) {
  struct msg m;
  va_list ap;
  va_start(ap, fmt);
  m_start(&m, id, opcode);
  for (; *fmt; fmt++) {
    switch (*fmt) {
      case 'u': m_u32(&m, va_arg(ap, uint32_t)); break;
      case 'i': m_u32(&m, (uint32_t)va_arg(ap, int32_t)); break;
      case 's': m_str(&m, va_arg(ap, const char *)); break;
      case 'a': { const void *p = va_arg(ap, const void *); uint32_t n = va_arg(ap, uint32_t); m_array(&m, p, n); break; }
    }
  }
  va_end(ap);
  m_send(c, &m);
}

static void fatal(struct client *c, uint32_t object, uint32_t code, const char *text) {
  ev(c, 1, 0, "uus", object, code, text);
  c->alive = 0;
}

/* ---- objects ---- */

static struct obj *obj_get(struct client *c, uint32_t id) {
  return id > 0 && id < MAX_OBJECTS ? &c->objs[id] : NULL;
}
static void obj_set(struct client *c, uint32_t id, enum type type, int version, void *data) {
  if (id == 0 || id >= MAX_OBJECTS) { fatal(c, 1, 0, "object id out of range"); return; }
  c->objs[id].type = type;
  c->objs[id].version = (uint8_t)version;
  c->objs[id].data = data;
}
static void obj_free(struct client *c, uint32_t id) {
  struct obj *o = obj_get(c, id);
  if (!o) return;
  o->type = T_NONE;
  o->data = NULL;
  ev(c, 1, 1, "u", id); /* wl_display.delete_id */
}

static void pool_unref(struct pool *p) {
  if (--p->refs == 0) { close(p->fd); free(p); }
}

/* ---- windows ---- */

static void window_close(struct window *w) {
  if (w->index < 0) return;
  for (int i = 0; i < 64; i++) if (wins[i] && &wins[i]->win == w) wins[i] = NULL;
  if (w->input >= 0) { close(w->input); w->input = -1; }
  if (w->fd >= 0) close(w->fd);
  if (w->pid > 0) {
    char cmd[64];
    snprintf(cmd, sizeof cmd, "kill %d", w->pid);
    system(cmd);
  }
  w->index = -1;
  w->fd = -1;
}

static uint32_t fb_mask(void) {
  uint32_t mask = 0;
  struct stat st;
  char path[32];
  for (int i = 0; i < 32; i++) {
    snprintf(path, sizeof path, "/dev/fb%d", i);
    if (stat(path, &st) == 0) mask |= 1u << i;
  }
  return mask;
}

/* Starts `fbwin` in the background and takes the framebuffer that appears. fbwin prints the device, but a window is
 * found by looking at /dev instead, which does not depend on where its output goes. */
static int window_open(struct surface *s, uint32_t width, uint32_t height) {
  char title[128], pidfile[320], cmd[1024];
  size_t j = 0;
  for (size_t i = 0; s->title[i] && j < sizeof title - 1; i++) {
    unsigned char ch = (unsigned char)s->title[i];
    title[j++] = (ch >= 32 && ch < 127 && ch != '\'' && ch != '\\') ? (char)ch : '_';
  }
  title[j] = 0;
  int n = next_window++;
  snprintf(pidfile, sizeof pidfile, "%s/wlcomp-%d.pid", runtime, n);
  unlink(pidfile);
  uint32_t before = fb_mask();
  snprintf(cmd, sizeof cmd, "fbwin -r -t '%s' %ux%u > /dev/null 2>&1 & echo $! > %s; disown",
           title[0] ? title : "Wayland", width, height, pidfile);
  LOG("window: %s", cmd);
  int status = system(cmd);
  LOG("window: system returned %d", status);

  int index = -1;
  for (int tries = 0; tries < 250 && index < 0; tries++) {
    uint32_t added = fb_mask() & ~before;
    for (int i = 0; i < 32; i++) if (added & (1u << i)) { index = i; break; }
    if (index < 0) usleep(20000);
  }
  LOG("window: device %d", index);
  if (index < 0) return -1;
  int pid = 0;
  FILE *pf = fopen(pidfile, "r");
  if (pf) { if (fscanf(pf, "%d", &pid) != 1) pid = 0; fclose(pf); }
  unlink(pidfile);
  char path[32];
  snprintf(path, sizeof path, "/dev/fb%d", index);
  int fd = open(path, O_RDWR);
  if (fd < 0) return -1;
  char inpath[48];
  snprintf(inpath, sizeof inpath, "/dev/input/event%d", 2 + index);
  s->win.input = open(inpath, O_RDONLY | O_NONBLOCK);
  for (int i = 0; i < 64; i++) if (!wins[i]) { wins[i] = s; break; }
  s->win.index = index;
  s->win.fd = fd;
  s->win.pid = pid;
  s->win.width = width;
  s->win.height = height;
  return 0;
}

/* A framebuffer whose window was closed answers every call with ENODEV, even though its node stays while we hold it open.
 * Returns 0 for gone, 1 for as before, 2 when the user gave the window another size (w is updated). */
static int window_probe(struct window *w) {
  uint8_t info[160]; /* struct fb_var_screeninfo */
  if (ioctl(w->fd, 0x4600 /* FBIOGET_VSCREENINFO */, info) != 0) return 0;
  uint32_t xres, yres;
  memcpy(&xres, info, 4);
  memcpy(&yres, info + 4, 4);
  if (xres == w->width && yres == w->height) return 1;
  w->width = xres;
  w->height = yres;
  return 2;
}

/* copies the surface's current buffer into its window: rows y0 up to y1 when the buffer is the window's size (that is
 * all a client that reports its damage changed), else the whole buffer, cropped or padded with black, in one write so
 * the window is never seen half-drawn */
/* a read or write may move less than asked (the system caps one at a megabyte), so go on until it is all there or nothing more comes */
static ssize_t pread_all(int fd, uint8_t *to, size_t n, off_t at) {
  size_t done = 0;
  while (done < n) {
    ssize_t got = pread(fd, to + done, n - done, at + (off_t)done);
    if (got <= 0) break;
    done += (size_t)got;
  }
  return (ssize_t)done;
}
static void pwrite_all(int fd, const uint8_t *from, size_t n, off_t at) {
  size_t done = 0;
  while (done < n) {
    ssize_t put = pwrite(fd, from + done, n - done, at + (off_t)done);
    if (put <= 0) break;
    done += (size_t)put;
  }
}
static uint8_t *scratch;
static size_t scratch_size;
static uint8_t *scratch_for(size_t n) {
  if (n > scratch_size) {
    uint8_t *bigger = realloc(scratch, n);
    if (!bigger) return NULL;
    scratch = bigger;
    scratch_size = n;
  }
  return scratch;
}
static void present(struct surface *s, uint32_t y0, uint32_t y1) {
  struct buffer *b = s->buffer;
  if (!b || s->win.index < 0) return;
  uint32_t src_stride = b->stride, dst_stride = s->win.width * 4;
  if (b->width == s->win.width && b->height == s->win.height && src_stride == dst_stride) {
    if (y1 > b->height) y1 = b->height;
    if (y0 >= y1) return;
    size_t n = (size_t)(y1 - y0) * dst_stride;
    uint8_t *tmp = scratch_for(n);
    if (!tmp) return;
    ssize_t got = pread_all(b->pool->fd, tmp, n, (off_t)b->offset + (off_t)y0 * src_stride);
    if (got <= 0) return;
    pwrite_all(s->win.fd, tmp, (size_t)got, (off_t)y0 * dst_stride);
    return;
  }
  size_t whole = (size_t)dst_stride * s->win.height, from = (size_t)src_stride * b->height;
  uint8_t *tmp = scratch_for(whole + from);
  if (!tmp) return;
  ssize_t got = pread_all(b->pool->fd, tmp + whole, from, b->offset);
  if (got < 0) got = 0;
  memset(tmp, 0, whole);
  uint32_t rows = b->height < s->win.height ? b->height : s->win.height;
  uint32_t cols = b->width < s->win.width ? b->width : s->win.width;
  for (uint32_t y = 0; y < rows; y++) {
    if ((size_t)(y + 1) * src_stride > (size_t)got) break;
    memcpy(tmp + (size_t)y * dst_stride, tmp + whole + (size_t)y * src_stride, (size_t)cols * 4);
  }
  pwrite_all(s->win.fd, tmp, whole, 0);
}

/* ---- the protocol ---- */

struct rd { const uint8_t *p, *end; int bad; };
static uint32_t r_u32(struct rd *r) {
  uint32_t v = 0;
  if (r->end - r->p < 4) { r->bad = 1; return 0; }
  memcpy(&v, r->p, 4);
  r->p += 4;
  return v;
}
static const char *r_str(struct rd *r) {
  uint32_t len = r_u32(r);
  if (r->bad || len == 0 || (size_t)(r->end - r->p) < ((len + 3) & ~3u) || r->p[len - 1] != 0) { r->bad = 1; return ""; }
  const char *s = (const char *)r->p;
  r->p += (len + 3) & ~3u;
  return s;
}
static int take_fd(struct client *c) {
  if (c->nfds == 0) return -1;
  int fd = c->fds[0];
  memmove(c->fds, c->fds + 1, sizeof(int) * (size_t)(--c->nfds));
  return fd;
}

static void send_configure(struct client *c, struct surface *s, uint32_t width, uint32_t height) {
  uint8_t states[4];
  memset(states, 0, sizeof states);
  ev(c, s->toplevel, 0, "iia", (int32_t)width, (int32_t)height, states, 0u);
  s->serial = serial_counter++;
  ev(c, s->xsurface, 0, "u", s->serial);
  s->configured = 1;
}

static void surface_commit(struct client *c, struct surface *s) {
  int attached = s->has_attach;
  if (s->has_attach) {
    s->buffer = s->attached;
    s->attached = NULL;
    s->has_attach = 0;
  }
  if (s->toplevel && !s->configured) { send_configure(c, s, 0, 0); return; }
  if (s->toplevel && s->buffer && s->acked) {
    if (!s->mapped) {
      if (window_open(s, s->buffer->width, s->buffer->height) == 0) s->mapped = 1;
      else { fatal(c, s->id, 0, "no window could be made"); return; }
    }
    /* damage a client reports narrows the copy; a client that reports none, a new buffer or a new window size gets all */
    uint32_t y0 = s->damage_y0, y1 = s->damage_y1;
    if (y1 <= y0 || !attached || (int)s->buffer->width != s->drawn_w || (int)s->buffer->height != s->drawn_h || s->win.width != (uint32_t)s->drawn_w || s->win.height != (uint32_t)s->drawn_h) { y0 = 0; y1 = s->buffer->height; }
    present(s, y0, y1);
    s->drawn_w = (int)s->buffer->width;
    s->drawn_h = (int)s->buffer->height;
  }
  s->damage_y0 = s->damage_y1 = 0;
  /* the buffer was copied, so it is free again */
  if (attached && s->buffer) {
    for (uint32_t id = 1; id < MAX_OBJECTS; id++) {
      struct obj *o = &c->objs[id];
      if (o->type == T_BUFFER && o->data == s->buffer) { ev(c, id, 0, ""); break; }
    }
  }
  for (int i = 0; i < s->nframes && ndue < (int)(sizeof due / sizeof due[0]); i++) {
    due[ndue].client = c;
    due[ndue].id = s->frames[i];
    ndue++;
  }
  s->nframes = 0;
}

static void surface_destroy(struct client *c, struct surface *s) {
  window_close(&s->win);
  if (s->xsurface) c->objs[s->xsurface].data = NULL;
  if (s->toplevel) c->objs[s->toplevel].data = NULL;
  free(s);
}

static void on_display(struct client *c, uint32_t opcode, struct rd *r) {
  uint32_t id = r_u32(r);
  if (r->bad) return;
  if (opcode == 0) {          /* sync */
    obj_set(c, id, T_CALLBACK, 1, NULL);
    ev(c, id, 0, "u", now_ms());
    obj_free(c, id);
  } else if (opcode == 1) {   /* get_registry */
    obj_set(c, id, T_REGISTRY, 1, NULL);
    ev(c, id, 0, "usu", (uint32_t)G_COMPOSITOR, "wl_compositor", 4u);
    ev(c, id, 0, "usu", (uint32_t)G_SHM, "wl_shm", 1u);
    ev(c, id, 0, "usu", (uint32_t)G_WMBASE, "xdg_wm_base", 2u);
    ev(c, id, 0, "usu", (uint32_t)G_OUTPUT, "wl_output", 2u);
    ev(c, id, 0, "usu", (uint32_t)G_SEAT, "wl_seat", 5u);
    ev(c, id, 0, "usu", (uint32_t)G_CURSORSHAPE, "wp_cursor_shape_manager_v1", 1u);
  } else fatal(c, 1, 1, "unknown wl_display request");
}

static void on_registry(struct client *c, uint32_t opcode, struct rd *r) {
  if (opcode != 0) return;
  uint32_t name = r_u32(r);
  const char *iface = r_str(r);
  uint32_t version = r_u32(r);
  uint32_t id = r_u32(r);
  if (r->bad) return;
  static const struct { enum global g; enum type t; const char *name; uint32_t max; } table[] = {
    { G_COMPOSITOR, T_COMPOSITOR, "wl_compositor", 4 }, { G_SHM, T_SHM, "wl_shm", 1 },
    { G_WMBASE, T_WMBASE, "xdg_wm_base", 2 }, { G_OUTPUT, T_OUTPUT, "wl_output", 2 }, { G_SEAT, T_SEAT, "wl_seat", 5 },
    { G_CURSORSHAPE, T_CSMGR, "wp_cursor_shape_manager_v1", 1 },
  };
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) {
    if ((uint32_t)table[i].g != name || strcmp(table[i].name, iface) != 0) continue;
    uint32_t v = version < table[i].max ? version : table[i].max;
    obj_set(c, id, table[i].t, (int)v, NULL);
    if (table[i].t == T_SHM) { ev(c, id, 0, "u", 0u); ev(c, id, 0, "u", 1u); }
    if (table[i].t == T_OUTPUT) {
      ev(c, id, 0, "iiiiissi", 0, 0, 270, 200, 0, "ecmaOS", "display", 0);
      ev(c, id, 1, "uiii", 1u, screen_w, screen_h, 60000);
      if (v >= 2) { ev(c, id, 3, "i", 1); ev(c, id, 2, ""); }
    }
    if (table[i].t == T_SEAT) { ev(c, id, 0, "u", 3u); if (v >= 2) ev(c, id, 1, "s", "seat0"); }
    return;
  }
  fatal(c, 2, 0, "no such global");
}

static void on_compositor(struct client *c, uint32_t opcode, struct rd *r) {
  uint32_t id = r_u32(r);
  if (r->bad) return;
  if (opcode == 0) {
    struct surface *s = calloc(1, sizeof *s);
    if (!s) { fatal(c, 1, 2, "out of memory"); return; }
    s->client = c;
    s->id = id;
    s->win.index = -1;
    s->win.fd = -1;
    s->win.input = -1;
    obj_set(c, id, T_SURFACE, 4, s);
  } else if (opcode == 1) obj_set(c, id, T_REGION, 1, NULL);
}

static void on_shm(struct client *c, uint32_t opcode, struct rd *r) {
  if (opcode != 0) return;
  uint32_t id = r_u32(r);
  uint32_t size = r_u32(r);
  int fd = take_fd(c);
  if (r->bad) return;
  if (fd < 0) { fatal(c, 0, 2, "no file descriptor with create_pool"); return; }
  struct pool *p = calloc(1, sizeof *p);
  if (!p) { close(fd); return; }
  p->fd = fd;
  p->size = size;
  p->refs = 1;
  obj_set(c, id, T_POOL, 1, p);
}

static void on_pool(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  struct pool *p = c->objs[self].data;
  if (opcode == 0) {
    uint32_t id = r_u32(r), offset = r_u32(r), width = r_u32(r), height = r_u32(r), stride = r_u32(r), format = r_u32(r);
    if (r->bad) return;
    if (format > 1) { fatal(c, self, 0, "unsupported format"); return; }
    if (stride < width * 4 || (uint64_t)offset + (uint64_t)stride * height > p->size) { fatal(c, self, 1, "invalid buffer"); return; }
    struct buffer *b = calloc(1, sizeof *b);
    if (!b) return;
    b->pool = p; p->refs++;
    b->offset = offset; b->width = width; b->height = height; b->stride = stride; b->format = format;
    obj_set(c, id, T_BUFFER, 1, b);
  } else if (opcode == 1) { pool_unref(p); obj_free(c, self); }
  else if (opcode == 2) { uint32_t size = r_u32(r); if (!r->bad && size > p->size) p->size = size; }
}

static void on_buffer(struct client *c, uint32_t self, uint32_t opcode) {
  if (opcode != 0) return;
  struct buffer *b = c->objs[self].data;
  /* a surface may still hold it: make the reference harmless by cloning nothing, since commits copy at once */
  for (uint32_t id = 1; id < MAX_OBJECTS; id++) {
    if (c->objs[id].type != T_SURFACE) continue;
    struct surface *s = c->objs[id].data;
    if (s->buffer == b) s->buffer = NULL;
    if (s->attached == b) { s->attached = NULL; }
  }
  pool_unref(b->pool);
  free(b);
  obj_free(c, self);
}

static void on_surface(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  struct surface *s = c->objs[self].data;
  switch (opcode) {
    case 0: surface_destroy(c, s); obj_free(c, self); break;
    case 1: {
      uint32_t id = r_u32(r);
      r_u32(r); r_u32(r);
      if (r->bad) return;
      struct obj *o = id ? obj_get(c, id) : NULL;
      s->attached = o && o->type == T_BUFFER ? o->data : NULL;
      s->has_attach = 1;
      break;
    }
    case 3: {
      uint32_t id = r_u32(r);
      if (r->bad) return;
      obj_set(c, id, T_CALLBACK, 1, NULL);
      if (s->nframes < 16) s->frames[s->nframes++] = id;
      break;
    }
    case 2: case 9: {   /* damage, damage_buffer: only the rows matter */
      r_u32(r);
      int32_t y = (int32_t)r_u32(r); r_u32(r);
      int32_t h = (int32_t)r_u32(r);
      if (r->bad || h <= 0) break;
      if (y < 0) { h += y; y = 0; }
      if (h <= 0) break;
      if (s->damage_y1 <= s->damage_y0) { s->damage_y0 = (uint32_t)y; s->damage_y1 = (uint32_t)(y + h); }
      else { if ((uint32_t)y < s->damage_y0) s->damage_y0 = (uint32_t)y; if ((uint32_t)(y + h) > s->damage_y1) s->damage_y1 = (uint32_t)(y + h); }
      break;
    }
    case 6: surface_commit(c, s); break;
    default: break; /* regions, transform, scale */
  }
}

static void on_wmbase(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  if (opcode == 0) obj_free(c, self);
  else if (opcode == 1) { uint32_t id = r_u32(r); if (!r->bad) obj_set(c, id, T_POSITIONER, 2, NULL); }
  else if (opcode == 2) {
    uint32_t id = r_u32(r), surf = r_u32(r);
    if (r->bad) return;
    struct obj *o = obj_get(c, surf);
    if (!o || o->type != T_SURFACE) { fatal(c, self, 0, "not a surface"); return; }
    struct surface *s = o->data;
    s->xsurface = id;
    obj_set(c, id, T_XSURFACE, 2, s);
  }
}

static void on_xsurface(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  struct surface *s = c->objs[self].data;
  if (!s) { if (opcode == 0) obj_free(c, self); return; }
  switch (opcode) {
    case 0: s->xsurface = 0; obj_free(c, self); break;
    case 1: {
      uint32_t id = r_u32(r);
      if (r->bad) return;
      s->toplevel = id;
      obj_set(c, id, T_TOPLEVEL, 2, s);
      break;
    }
    case 2: fatal(c, self, 0, "popups are not supported"); break;
    case 4: { uint32_t serial = r_u32(r); if (!r->bad && serial == s->serial) s->acked = 1; break; }
    default: break;
  }
}

static void on_toplevel(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  struct surface *s = c->objs[self].data;
  if (!s) { if (opcode == 0) obj_free(c, self); return; }
  switch (opcode) {
    case 0:
      window_close(&s->win);
      s->toplevel = 0; s->mapped = 0; s->configured = 0; s->acked = 0;
      obj_free(c, self);
      break;
    case 2: {
      const char *t = r_str(r);
      if (!r->bad) snprintf(s->title, sizeof s->title, "%s", t);
      break;
    }
    default: break;
  }
}

static void send_keymap(struct client *c, uint32_t id);

static void on_seat(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  uint32_t id = r_u32(r);
  if (opcode == 3) { obj_free(c, self); return; }
  if (r->bad) return;
  uint32_t v = c->objs[self].version;
  if (opcode == 0) {
    c->pointer = id;
    obj_set(c, id, T_POINTER, (int)v, NULL);
  } else if (opcode == 1) {
    c->keyboard = id;
    obj_set(c, id, T_KEYBOARD, (int)v, NULL);
    send_keymap(c, id);
  } else fatal(c, self, 0, "no touch");
}

/* ---- cursors ---- */

/* wp_cursor_shape_device_v1.shape (1..34) as the CSS cursor the window shows */
static const char *const shape_css[] = {
  NULL, "default", "context-menu", "help", "pointer", "progress", "wait", "cell", "crosshair", "text", "vertical-text",
  "alias", "copy", "move", "no-drop", "not-allowed", "grab", "grabbing", "e-resize", "n-resize", "ne-resize", "nw-resize",
  "s-resize", "se-resize", "sw-resize", "w-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "col-resize",
  "row-resize", "all-scroll", "zoom-in", "zoom-out"
};

/* shows `name` (a CSS cursor, or "none") over the window of c that the pointer is in; the fb takes it as FBIO 0x46f0 */
static void set_cursor(struct client *c, const char *name) {
  for (size_t i = 0; i < sizeof wins / sizeof wins[0]; i++) {
    struct surface *s = wins[i];
    if (!s || s->client != c || !s->pointer_in || s->win.fd < 0) continue;
    char buf[64];
    memset(buf, 0, sizeof buf);
    strncpy(buf, name, sizeof buf - 1);
    ioctl(s->win.fd, 0x46f0, buf);
  }
}

static void on_csmgr(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  if (opcode == 0) { obj_free(c, self); return; }
  if (opcode != 1) { fatal(c, self, 0, "no tablets"); return; }
  uint32_t id = r_u32(r);
  r_u32(r);   /* the wl_pointer */
  if (!r->bad) obj_set(c, id, T_CSDEV, 1, NULL);
}

static void on_csdev(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  if (opcode == 0) { obj_free(c, self); return; }
  if (opcode != 1) return;
  r_u32(r);   /* serial */
  uint32_t shape = r_u32(r);
  if (r->bad) return;
  if (shape < 1 || shape >= sizeof shape_css / sizeof shape_css[0]) { fatal(c, self, 1, "invalid shape"); return; }
  set_cursor(c, shape_css[shape]);
}

static void on_pointer(struct client *c, uint32_t self, uint32_t opcode, struct rd *r) {
  if (opcode == 1) { if (c->pointer == self) c->pointer = 0; obj_free(c, self); return; }
  if (opcode != 0) return;
  r_u32(r);   /* serial */
  uint32_t surface = r_u32(r);
  if (r->bad) return;
  /* no surface hides the cursor; an image from the client cannot be shown yet, so the arrow stands in for it */
  set_cursor(c, surface ? "default" : "none");
}

static void dispatch(struct client *c, uint32_t id, uint32_t opcode, struct rd *r) {
  struct obj *o = obj_get(c, id);
  if (id == 1) { on_display(c, opcode, r); return; }
  if (!o || o->type == T_NONE) { fatal(c, 1, 0, "request to an unknown object"); return; }
  switch (o->type) {
    case T_REGISTRY: on_registry(c, opcode, r); break;
    case T_COMPOSITOR: on_compositor(c, opcode, r); break;
    case T_REGION: if (opcode == 0) obj_free(c, id); break;
    case T_SHM: on_shm(c, opcode, r); break;
    case T_POOL: on_pool(c, id, opcode, r); break;
    case T_BUFFER: on_buffer(c, id, opcode); break;
    case T_SURFACE: on_surface(c, id, opcode, r); break;
    case T_WMBASE: on_wmbase(c, id, opcode, r); break;
    case T_XSURFACE: on_xsurface(c, id, opcode, r); break;
    case T_TOPLEVEL: on_toplevel(c, id, opcode, r); break;
    case T_POSITIONER: if (opcode == 0) obj_free(c, id); break;
    case T_OUTPUT: if (opcode == 0) obj_free(c, id); break;
    case T_SEAT: on_seat(c, id, opcode, r); break;
    case T_POINTER: on_pointer(c, id, opcode, r); break;
    case T_CSMGR: on_csmgr(c, id, opcode, r); break;
    case T_CSDEV: on_csdev(c, id, opcode, r); break;
    case T_KEYBOARD: if (opcode == 0) { if (c->keyboard == id) c->keyboard = 0; obj_free(c, id); } break;
    default: break;
  }
}


/* ---- input ---- */

/* The US layout, expanded: no include statements, so a client's libxkbcommon needs no xkb data files. keymap-us.xkb is
 * `xkbcli compile-keymap --layout us`; build.sh turns it into keymap-us.h. */
#include "keymap-us.h"
#define EV_KEY 1
#define EV_REL 2
#define EV_ABS 3
#define EV_MSC 4
#define MSC_POINTER_ENTER 0x100
#define MSC_KEYBOARD_FOCUS 0x101

static int live(struct client *c, uint32_t id, enum type t) {
  struct obj *o = id ? obj_get(c, id) : NULL;
  return o && o->type == t;
}

static int32_t fixed(int v) { return v * 256; }

static void send_keymap(struct client *c, uint32_t id) {
  char path[320];
  snprintf(path, sizeof path, "%s/wlcomp-keymap-XXXXXX", runtime);
  int fd = mkstemp(path);
  if (fd < 0) return;
  unlink(path);
  size_t n = keymap_us_xkb_len + 1;   /* with the NUL */
  if (write(fd, keymap_us_xkb, keymap_us_xkb_len) != (ssize_t)keymap_us_xkb_len || write(fd, "", 1) != 1) { close(fd); return; }
  send_fd = fd;
  ev(c, id, 0, "uu", 1u, (uint32_t)n);   /* xkb_v1 */
  send_fd = -1;
  close(fd);
  if (c->objs[id].version >= 4) ev(c, id, 5, "ii", 25, 600);
}

static uint32_t modifier_bit(unsigned code) {
  switch (code) {
    case 42: case 54: return 1;        /* shift */
    case 29: case 97: return 4;        /* control */
    case 56: case 100: return 8;       /* alt (mod1) */
    case 125: case 126: return 0x40;   /* logo (mod4) */
  }
  return 0;
}

static void key_event(struct surface *s, unsigned code, int value) {
  struct client *c = s->client;
  if (!live(c, c->keyboard, T_KEYBOARD) || !s->keyboard_in) return;
  if (value == 2) return;   /* the client repeats on its own (repeat_info) */
  if (code < 256) { if (value) s->down[code >> 3] |= 1 << (code & 7); else s->down[code >> 3] &= ~(1 << (code & 7)); }
  uint32_t t = now_ms(), before = s->mods_depressed | s->mods_locked;
  uint32_t bit = modifier_bit(code);
  if (bit) { if (value) s->mods_depressed |= bit; else s->mods_depressed &= ~bit; }
  if (code == 58 && value) s->mods_locked ^= 2;   /* caps lock */
  ev(c, c->keyboard, 3, "uuuu", serial_counter++, t, code, value ? 1u : 0u);
  if ((s->mods_depressed | s->mods_locked) != before) ev(c, c->keyboard, 4, "uuuuu", serial_counter++, s->mods_depressed, 0u, s->mods_locked, 0u);
}

static void input_record(struct surface *s, uint16_t type, uint16_t code, int32_t value) {
  struct client *c = s->client;
  int pointer = live(c, c->pointer, T_POINTER);
  uint32_t t = now_ms();
  if (type == EV_ABS) {
    if (code == 0) s->px = value; else if (code == 1) s->py = value;
    s->moved = 1;
  } else if (type == 0 /* SYN */) {
    if (s->moved && pointer && s->pointer_in) {
      ev(c, c->pointer, 2, "uii", t, fixed(s->px), fixed(s->py));
      if (c->objs[c->pointer].version >= 5) ev(c, c->pointer, 5, "");
    }
    s->moved = 0;
  } else if (type == EV_MSC && code == MSC_POINTER_ENTER) {
    if (!pointer) return;
    s->pointer_in = value != 0;
    if (value) ev(c, c->pointer, 0, "uuii", serial_counter++, s->id, fixed(s->px), fixed(s->py));
    else ev(c, c->pointer, 1, "uu", serial_counter++, s->id);
    if (c->objs[c->pointer].version >= 5) ev(c, c->pointer, 5, "");
  } else if (type == EV_MSC && code == MSC_KEYBOARD_FOCUS) {
    if (!live(c, c->keyboard, T_KEYBOARD)) return;
    s->keyboard_in = value != 0;
    if (value) {
      uint32_t keys[64];
      uint32_t n = 0;
      for (unsigned k = 0; k < 256 && n < 64; k++) if (s->down[k >> 3] & (1 << (k & 7))) keys[n++] = k;
      ev(c, c->keyboard, 1, "uua", serial_counter++, s->id, keys, n * 4);
    } else ev(c, c->keyboard, 2, "uu", serial_counter++, s->id);
  } else if (type == EV_KEY) {
    if (code >= 0x110 && code < 0x120) {
      if (pointer && s->pointer_in) {
        ev(c, c->pointer, 3, "uuuu", serial_counter++, t, code, value ? 1u : 0u);
        if (c->objs[c->pointer].version >= 5) ev(c, c->pointer, 5, "");
      }
    } else key_event(s, code, value);
  } else if (type == EV_REL && (code == 8 || code == 6)) {
    if (pointer && s->pointer_in) {
      ev(c, c->pointer, 4, "uui", t, code == 8 ? 0u : 1u, code == 8 ? -fixed(10 * value) : fixed(10 * value));
      if (c->objs[c->pointer].version >= 5) ev(c, c->pointer, 5, "");
    }
  }
}

static void read_input(struct surface *s) {
  unsigned char buf[24 * 32];
  for (;;) {
    ssize_t n = read(s->win.input, buf, sizeof buf);
    if (n <= 0) return;
    for (ssize_t at = 0; at + 24 <= n; at += 24) {
      uint16_t type, code;
      int32_t value;
      memcpy(&type, buf + at + 16, 2);
      memcpy(&code, buf + at + 18, 2);
      memcpy(&value, buf + at + 20, 4);
      input_record(s, type, code, value);
    }
    if ((size_t)n < sizeof buf) return;
  }
}

/* ---- clients ---- */

static void client_free(struct client *c) {
  for (uint32_t id = 1; id < MAX_OBJECTS; id++) {
    struct obj *o = &c->objs[id];
    if (o->type == T_SURFACE) surface_destroy(c, o->data);
    else if (o->type == T_POOL) pool_unref(o->data);
    else if (o->type == T_BUFFER) { struct buffer *b = o->data; pool_unref(b->pool); free(b); }
  }
  for (int i = 0; i < c->nfds; i++) close(c->fds[i]);
  for (int i = 0; i < ndue;) {
    if (due[i].client == c) due[i] = due[--ndue]; else i++;
  }
  close(c->fd);
  free(c);
}

static void client_read(struct client *c) {
  char control[CMSG_SPACE(sizeof(int) * 8)];
  struct iovec io = { c->in + c->inlen, INBUF - c->inlen };
  struct msghdr m;
  memset(&m, 0, sizeof m);
  m.msg_iov = &io; m.msg_iovlen = 1;
  m.msg_control = control; m.msg_controllen = sizeof control;
  ssize_t n = recvmsg(c->fd, &m, 0);
  if (n == 0) { c->alive = 0; return; }
  if (n < 0) { if (errno != EAGAIN && errno != EINTR) c->alive = 0; return; }
  for (struct cmsghdr *h = CMSG_FIRSTHDR(&m); h; h = CMSG_NXTHDR(&m, h)) {
    if (h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_RIGHTS) continue;
    int count = (int)((h->cmsg_len - CMSG_LEN(0)) / sizeof(int));
    int got[8];
    memcpy(got, CMSG_DATA(h), sizeof(int) * (size_t)count);
    for (int i = 0; i < count; i++) { if (c->nfds < MAX_FDS) c->fds[c->nfds++] = got[i]; else close(got[i]); }
  }
  c->inlen += (size_t)n;
  size_t at = 0;
  while (c->alive && c->inlen - at >= 8) {
    uint32_t id, head;
    memcpy(&id, c->in + at, 4);
    memcpy(&head, c->in + at + 4, 4);
    uint32_t size = head >> 16, opcode = head & 0xffff;
    if (size < 8 || size % 4) { fatal(c, 1, 1, "bad message size"); break; }
    if (c->inlen - at < size) break;
    struct rd r = { c->in + at + 8, c->in + at + size, 0 };
    LOG("request object=%u opcode=%u size=%u", id, opcode, size);
    dispatch(c, id, opcode, &r);
    if (r.bad && c->alive) fatal(c, id, 1, "malformed request");
    at += size;
  }
  memmove(c->in, c->in + at, c->inlen - at);
  c->inlen -= at;
}

static void check_windows(void) {
  for (int i = 0; i < MAX_CLIENTS; i++) {
    struct client *c = clients[i];
    if (!c) continue;
    for (uint32_t id = 1; id < MAX_OBJECTS; id++) {
      if (c->objs[id].type != T_SURFACE) continue;
      struct surface *s = c->objs[id].data;
      if (!s->mapped || s->win.index < 0) continue;
      int state = window_probe(&s->win);
      if (state == 2 && s->toplevel) { LOG("window %d is now %ux%u", s->win.index, s->win.width, s->win.height); send_configure(c, s, s->win.width, s->win.height); present(s, 0, s->win.height); continue; }   /* what it had, meanwhile, rather than a blank */
      if (state != 0) continue;
      LOG("window %d is gone", s->win.index);
      s->win.pid = 0;
      window_close(&s->win);
      s->win.fd = -1;
      s->win.index = -1;
      s->mapped = 0;
      if (s->toplevel) ev(c, s->toplevel, 1, ""); /* xdg_toplevel.close */
    }
  }
}

int main(void) {
  const char *dir = getenv("XDG_RUNTIME_DIR");
  const char *display = getenv("WAYLAND_DISPLAY");
  char fallback[64];
  if (!dir || !*dir) { snprintf(fallback, sizeof fallback, "/run/user/%d", (int)getuid()); dir = fallback; }
  if (!display || !*display) display = "wayland-0";
  snprintf(runtime, sizeof runtime, "%s", dir);
  for (char *p = runtime + 1; *p; p++) {
    if (*p == '/') { *p = 0; mkdir(runtime, 0755); *p = '/'; }
  }
  mkdir(runtime, 0700);

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof addr.sun_path, "%s/%s", runtime, display);
  int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
  if (listener < 0 || bind(listener, (struct sockaddr *)&addr, sizeof addr) < 0 || listen(listener, 8) < 0) {
    fprintf(stderr, "wlcomp: cannot listen on %s: %s\n", addr.sun_path, strerror(errno));
    return 1;
  }
  debug = getenv("WLCOMP_DEBUG") != NULL;
  printf("wlcomp: listening on %s\n", addr.sun_path);
  fflush(stdout);

  uint32_t last_check = now_ms();
  for (;;) {
    struct pollfd fds[MAX_CLIENTS + 1];
    int slot[MAX_CLIENTS + 1];
    int n = 0;
    fds[n].fd = listener; fds[n].events = POLLIN; slot[n++] = -1;
    for (int i = 0; i < MAX_CLIENTS; i++) {
      if (!clients[i]) continue;
      fds[n].fd = clients[i]->fd; fds[n].events = POLLIN; slot[n++] = i;
    }
    int windows_open = 0;
    for (int i = 0; i < 64; i++) if (wins[i] && wins[i]->win.input >= 0) windows_open = 1;
    poll(fds, (nfds_t)n, ndue > 0 || windows_open ? 16 : 100);
    for (int i = 0; i < 64; i++) if (wins[i] && wins[i]->win.input >= 0) read_input(wins[i]);
    for (int k = 0; k < n; k++) {
      if (!(fds[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      if (slot[k] < 0) {
        int fd = accept4(listener, NULL, NULL, SOCK_NONBLOCK);
        if (fd < 0) continue;
        int free_slot = -1;
        for (int i = 0; i < MAX_CLIENTS; i++) if (!clients[i]) { free_slot = i; break; }
        if (free_slot < 0) { close(fd); continue; }
        struct client *c = calloc(1, sizeof *c);
        if (!c) { close(fd); continue; }
        LOG("client connected");
        c->fd = fd;
        c->alive = 1;
        c->objs[1].type = T_DISPLAY;
        clients[free_slot] = c;
      } else {
        struct client *c = clients[slot[k]];
        client_read(c);
        if (!c->alive) { client_free(c); clients[slot[k]] = NULL; }
      }
    }
    /* frame callbacks, at most one round every 16 ms */
    if (ndue > 0) {
      uint32_t t = now_ms();
      struct due batch[256];
      int count = ndue;
      memcpy(batch, due, sizeof(struct due) * (size_t)count);
      ndue = 0;
      for (int i = 0; i < count; i++) {
        struct client *c = batch[i].client;
        int still = 0;
        for (int j = 0; j < MAX_CLIENTS; j++) if (clients[j] == c) still = 1;
        if (!still) continue;
        ev(c, batch[i].id, 0, "u", t);
        obj_free(c, batch[i].id);
      }
    }
    if (now_ms() - last_check > 33) { last_check = now_ms(); check_windows(); }
    for (int i = 0; i < MAX_CLIENTS; i++) {
      if (clients[i] && !clients[i]->alive) { client_free(clients[i]); clients[i] = NULL; }
    }
  }
}
