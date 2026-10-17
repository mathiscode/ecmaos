/* The same test client as wl-shm.c, written against libwayland-client instead of by hand (see core/utils/wasm/lib/wayland.sh).
 * Usage: wl-lib [FRAMES] [WIDTH] [HEIGHT] [HOLD_MS]. Build: wl-lib.build.sh */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct wl_seat *seat;
static struct wl_surface *surface;
static struct wl_buffer *buffer;
static uint32_t *pixels;
static size_t pixels_size;
static int configured, closed, want_w, want_h;
static uint32_t config_serial;
static struct xdg_surface *xsurface;

static void registry_global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
  (void)data;
  printf("global %u %s\n", name, iface);
  if (!strcmp(iface, "wl_compositor")) compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
  else if (!strcmp(iface, "wl_shm")) shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
  else if (!strcmp(iface, "xdg_wm_base")) wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 2);
  else if (!strcmp(iface, "wl_seat")) seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
}
static void registry_remove(void *data, struct wl_registry *reg, uint32_t name) { (void)data; (void)reg; (void)name; }
static const struct wl_registry_listener registry_listener = { registry_global, registry_remove };

static void wm_ping(void *data, struct xdg_wm_base *wm, uint32_t serial) { (void)data; xdg_wm_base_pong(wm, serial); }
static const struct xdg_wm_base_listener wm_listener = { wm_ping };

static void xs_configure(void *data, struct xdg_surface *xs, uint32_t serial) {
  (void)data;
  config_serial = serial;
  if (configured) xdg_surface_ack_configure(xs, serial);   /* a later configure: ack at once */
  configured = 1;
}
static const struct xdg_surface_listener xs_listener = { xs_configure };

static void tl_configure(void *data, struct xdg_toplevel *tl, int32_t w, int32_t h, struct wl_array *states) {
  (void)data; (void)tl; (void)states;
  if (w > 0 && h > 0) { want_w = w; want_h = h; }
}
static void tl_close(void *data, struct xdg_toplevel *tl) { (void)data; (void)tl; closed = 1; }
static const struct xdg_toplevel_listener tl_listener = { tl_configure, tl_close, NULL, NULL };

static void ptr_enter(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y) {
  (void)d; (void)p; (void)serial;
  printf("pointer enter surface=%s %d %d\n", s == surface ? "mine" : "other", wl_fixed_to_int(x), wl_fixed_to_int(y));
}
static void ptr_leave(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) { (void)d; (void)p; (void)serial; (void)s; printf("pointer leave\n"); }
static void ptr_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) { (void)d; (void)p; (void)t; printf("pointer motion %d %d\n", wl_fixed_to_int(x), wl_fixed_to_int(y)); }
static void ptr_button(void *d, struct wl_pointer *p, uint32_t serial, uint32_t t, uint32_t b, uint32_t state) { (void)d; (void)p; (void)serial; (void)t; printf("pointer button %u %u\n", b, state); }
static void ptr_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t axis, wl_fixed_t v) { (void)d; (void)p; (void)t; printf("pointer axis %u %d\n", axis, wl_fixed_to_int(v)); }
static void ptr_frame(void *d, struct wl_pointer *p) { (void)d; (void)p; }
static void ptr_axis_source(void *d, struct wl_pointer *p, uint32_t s) { (void)d; (void)p; (void)s; }
static void ptr_axis_stop(void *d, struct wl_pointer *p, uint32_t t, uint32_t a) { (void)d; (void)p; (void)t; (void)a; }
static void ptr_axis_discrete(void *d, struct wl_pointer *p, uint32_t a, int32_t v) { (void)d; (void)p; (void)a; (void)v; }
static const struct wl_pointer_listener ptr_listener = { ptr_enter, ptr_leave, ptr_motion, ptr_button, ptr_axis, ptr_frame, ptr_axis_source, ptr_axis_stop, ptr_axis_discrete };

static struct xkb_context *xkb;
static struct xkb_keymap *keymap;
static struct xkb_state *xstate;

static void kb_keymap(void *d, struct wl_keyboard *k, uint32_t format, int32_t fd, uint32_t size) {
  (void)d; (void)k;
  char *text = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (text != MAP_FAILED) {
    if (!xkb) xkb = xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES | XKB_CONTEXT_NO_ENVIRONMENT_NAMES);
    keymap = xkb_keymap_new_from_buffer(xkb, text, size - 1, XKB_KEYMAP_FORMAT_TEXT_V1, XKB_KEYMAP_COMPILE_NO_FLAGS);
    xstate = keymap ? xkb_state_new(keymap) : NULL;
    munmap(text, size);
  }
  printf("keyboard keymap format=%u %s\n", format, xstate ? "parsed" : "unreadable");
  close(fd);
  fflush(stdout);
}
static void kb_enter(void *d, struct wl_keyboard *k, uint32_t serial, struct wl_surface *s, struct wl_array *keys) { (void)d; (void)k; (void)serial; (void)s; printf("keyboard enter keys=%zu\n", keys->size / 4); fflush(stdout); }
static void kb_leave(void *d, struct wl_keyboard *k, uint32_t serial, struct wl_surface *s) { (void)d; (void)k; (void)serial; (void)s; printf("keyboard leave\n"); fflush(stdout); }
static void kb_key(void *d, struct wl_keyboard *k, uint32_t serial, uint32_t t, uint32_t key, uint32_t state) { (void)d; (void)k; (void)serial; (void)t; 
  char name[64] = "";
  if (xstate) {
    xkb_keysym_t sym = xkb_state_key_get_one_sym(xstate, key + 8);
    xkb_keysym_get_name(sym, name, sizeof name);
  }
  printf("keyboard key %u %u %s\n", key, state, name); fflush(stdout); }
static void kb_modifiers(void *d, struct wl_keyboard *k, uint32_t serial, uint32_t dep, uint32_t lat, uint32_t lock, uint32_t group) { (void)d; (void)k; (void)serial; if (xstate) xkb_state_update_mask(xstate, dep, lat, lock, 0, 0, group); printf("keyboard modifiers %u %u %u\n", dep, lat, lock); fflush(stdout); }
static void kb_repeat(void *d, struct wl_keyboard *k, int32_t rate, int32_t delay) { (void)d; (void)k; (void)rate; (void)delay; }
static const struct wl_keyboard_listener kb_listener = { kb_keymap, kb_enter, kb_leave, kb_key, kb_modifiers, kb_repeat };

static void seat_caps(void *d, struct wl_seat *s, uint32_t caps) {
  (void)d;
  if (caps & WL_SEAT_CAPABILITY_POINTER) wl_pointer_add_listener(wl_seat_get_pointer(s), &ptr_listener, NULL);
  if (caps & WL_SEAT_CAPABILITY_KEYBOARD) wl_keyboard_add_listener(wl_seat_get_keyboard(s), &kb_listener, NULL);
}
static void seat_name(void *d, struct wl_seat *s, const char *n) { (void)d; (void)s; (void)n; }
static const struct wl_seat_listener seat_listener = { seat_caps, seat_name };

static int frame_done;
static void frame_cb(void *d, struct wl_callback *cb, uint32_t t) { (void)d; (void)t; frame_done = 1; wl_callback_destroy(cb); }
static const struct wl_callback_listener frame_listener = { frame_cb };

static void new_buffer(const char *dir, int w, int h) {
  char path[256];
  snprintf(path, sizeof path, "%s/wl-lib-XXXXXX", dir);
  int fd = mkstemp(path);
  if (fd < 0) { printf("mkstemp failed %d\n", errno); exit(1); }
  unlink(path);
  size_t size = (size_t)w * h * 4;
  if (ftruncate(fd, (off_t)size) < 0) { printf("ftruncate failed\n"); exit(1); }
  if (pixels) munmap(pixels, pixels_size);
  pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED) { printf("mmap failed %d\n", errno); exit(1); }
  pixels_size = size;
  struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)size);
  if (buffer) wl_buffer_destroy(buffer);
  buffer = wl_shm_pool_create_buffer(pool, 0, w, h, w * 4, WL_SHM_FORMAT_XRGB8888);
  wl_shm_pool_destroy(pool);
  close(fd);
}

static void paint(int w, int h, int i) {
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++)
    pixels[y * w + x] = (uint32_t)(((x * 255 / w) << 16) | ((y * 255 / h) << 8) | ((i * 60) & 255));
}

int main(int argc, char **argv) {
  int frames = argc > 1 ? atoi(argv[1]) : 3;
  int w = argc > 2 ? atoi(argv[2]) : 160, h = argc > 3 ? atoi(argv[3]) : 100;
  int hold = argc > 4 ? atoi(argv[4]) : 0;
  setvbuf(stdout, NULL, _IOLBF, 0);
  const char *dir = getenv("XDG_RUNTIME_DIR");
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) { printf("connect failed %d\n", errno); return 1; }
  printf("connected\n");
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!compositor || !shm || !wm_base) { printf("missing globals\n"); return 1; }
  xdg_wm_base_add_listener(wm_base, &wm_listener, NULL);
  if (seat) { wl_seat_add_listener(seat, &seat_listener, NULL); wl_display_roundtrip(display); }

  surface = wl_compositor_create_surface(compositor);
  xsurface = xdg_wm_base_get_xdg_surface(wm_base, surface);
  xdg_surface_add_listener(xsurface, &xs_listener, NULL);
  struct xdg_toplevel *toplevel = xdg_surface_get_toplevel(xsurface);
  xdg_toplevel_add_listener(toplevel, &tl_listener, NULL);
  xdg_toplevel_set_title(toplevel, "wl-lib");
  wl_surface_commit(surface);
  while (!configured && wl_display_dispatch(display) >= 0) {}
  if (!configured) { printf("not configured\n"); return 1; }
  printf("configured\n");
  xdg_surface_ack_configure(xsurface, config_serial);

  new_buffer(dir, w, h);
  for (int i = 0; i < frames && !closed; i++) {
    paint(w, h, i);
    frame_done = 0;
    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, w, h);
    wl_callback_add_listener(wl_surface_frame(surface), &frame_listener, NULL);
    wl_surface_commit(surface);
    while (!frame_done && !closed && wl_display_dispatch(display) >= 0) {}
    if (closed) break;
    printf("frame %d\n", i);
  }
  printf(closed ? "closed\n" : "done\n");

  /* stay up, so the window can be looked at; a close request from the compositor ends it */
  for (int waited = 0; waited < hold && !closed; waited += 50) {
    while (wl_display_prepare_read(display) != 0) wl_display_dispatch_pending(display);
    wl_display_flush(display);
    struct pollfd p = { wl_display_get_fd(display), POLLIN, 0 };
    if (poll(&p, 1, 50) > 0) wl_display_read_events(display); else wl_display_cancel_read(display);
    wl_display_dispatch_pending(display);
    if (want_w && (want_w != w || want_h != h)) {
      w = want_w; h = want_h;
      new_buffer(dir, w, h);
      paint(w, h, 9);
      wl_surface_attach(surface, buffer, 0, 0);
      wl_surface_commit(surface);
      printf("resized %d %d\n", w, h);
    }
  }
  printf(closed ? "closed\n" : "exit\n");
  wl_display_disconnect(display);
  return 0;
}
