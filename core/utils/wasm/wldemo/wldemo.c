/* SPDX-License-Identifier: MIT OR Apache-2.0
 * wldemo: a small Wayland client for ecmaOS, to look at what wlcomp shows and sends. A resizable window with a
 * gradient, a ball that bounces (one frame per frame callback), a square that follows the pointer and turns red
 * while a button is down, and the last key typed, named by libxkbcommon. Escape or closing the window quits.
 * Written against libwayland-client and libxkbcommon (see wasm/lib). Usage: wldemo [WIDTH] [HEIGHT]. Without XDG_RUNTIME_DIR and WAYLAND_DISPLAY it uses /run/user/UID and wayland-0, as wlcomp does. */
#include <errno.h>
#include <fcntl.h>
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
static struct xdg_surface *xsurface;
static struct wl_buffer *buffer;
static struct wl_callback *frame;
static uint32_t *pixels;
static size_t pixels_size;
static int width = 320, height = 240, configured, closed, want_w, want_h;
static int px = -1, py = -1, down, inside;
static char last_key[64] = "";
static float bx = 40, by = 40, vx = 3, vy = 2;

static struct xkb_context *xkb;
static struct xkb_keymap *keymap;
static struct xkb_state *xstate;

/* 5x7 glyphs, one byte a row, the low five bits: 0-9, A-Z, underscore, then '?' for anything else. */
static const uint8_t font[38][7] = {
  {14,17,19,21,25,17,14},{4,12,4,4,4,4,14},{14,17,1,2,4,8,31},{14,17,1,6,1,17,14},{2,6,10,18,31,2,2},{31,16,30,1,1,17,14},{6,8,16,30,17,17,14},{31,1,2,4,8,8,8},{14,17,17,14,17,17,14},{14,17,17,15,1,2,12},
  {14,17,17,31,17,17,17},{30,17,17,30,17,17,30},{14,17,16,16,16,17,14},{30,17,17,17,17,17,30},{31,16,16,30,16,16,31},{31,16,16,30,16,16,16},{14,17,16,23,17,17,15},{17,17,17,31,17,17,17},{14,4,4,4,4,4,14},{7,2,2,2,2,18,12},{17,18,20,24,20,18,17},{16,16,16,16,16,16,31},{17,27,21,21,17,17,17},{17,17,25,21,19,17,17},{14,17,17,17,17,17,14},{30,17,17,30,16,16,16},{14,17,17,17,21,18,13},{30,17,17,30,20,18,17},{15,16,16,14,1,1,30},{31,4,4,4,4,4,4},{17,17,17,17,17,17,14},{17,17,17,17,17,10,4},{17,17,17,21,21,27,17},{17,17,10,4,10,17,17},{17,17,10,4,4,4,4},{31,1,2,4,8,16,31},{0,0,0,0,0,0,31},{14,17,1,2,4,0,4}
};

static void put_char(int x, int y, char ch, int scale, uint32_t color) {
  int g = 37;
  if (ch >= '0' && ch <= '9') g = ch - '0';
  else if (ch >= 'A' && ch <= 'Z') g = 10 + ch - 'A';
  else if (ch >= 'a' && ch <= 'z') g = 10 + ch - 'a';
  else if (ch == '_') g = 36;
  else if (ch == ' ') return;
  for (int r = 0; r < 7; r++) for (int c = 0; c < 5; c++) {
    if (!(font[g][r] & (16 >> c))) continue;
    for (int sy = 0; sy < scale; sy++) for (int sx = 0; sx < scale; sx++) {
      int xx = x + c * scale + sx, yy = y + r * scale + sy;
      if (xx >= 0 && xx < width && yy >= 0 && yy < height) pixels[yy * width + xx] = color;
    }
  }
}
static void put_text(int x, int y, const char *s, int scale, uint32_t color) {
  for (; *s; s++, x += 6 * scale) put_char(x, y, *s, scale, color);
}
static void fill(int x0, int y0, int w, int h, uint32_t color) {
  for (int y = y0 < 0 ? 0 : y0; y < y0 + h && y < height; y++)
    for (int x = x0 < 0 ? 0 : x0; x < x0 + w && x < width; x++) pixels[y * width + x] = color;
}

/* The gradient and the title never change at a given size, so they are drawn once into `background`; a frame repairs
 * only the places the ball, the pointer's square and the key name were, draws them again, and reports just those. */
static uint32_t *background;
struct rect { int x, y, w, h; };
static struct rect prev_ball, prev_ptr;
static int full = 1;

static void draw_background(void) {
  free(background);
  background = malloc((size_t)width * height * 4);
  if (!background) exit(1);
  uint32_t *saved = pixels;
  pixels = background;
  for (int y = 0; y < height; y++) {
    uint32_t shade = 24 + (uint32_t)(y * 56 / height);
    for (int x = 0; x < width; x++) pixels[y * width + x] = (shade / 2 << 16) | (shade << 8) | (shade + 60);
  }
  put_text(8, 8, "WLDEMO", 3, 0xffffffff);
  pixels = saved;
  memcpy(pixels, background, (size_t)width * height * 4);
  prev_ball = prev_ptr = (struct rect){ 0, 0, 0, 0 };
  full = 1;
}

static struct rect clip(struct rect r) {
  if (r.x < 0) { r.w += r.x; r.x = 0; }
  if (r.y < 0) { r.h += r.y; r.y = 0; }
  if (r.x + r.w > width) r.w = width - r.x;
  if (r.y + r.h > height) r.h = height - r.y;
  if (r.w < 0) r.w = 0;
  if (r.h < 0) r.h = 0;
  return r;
}
static void repair(struct rect r) {
  r = clip(r);
  for (int y = r.y; y < r.y + r.h; y++) memcpy(pixels + y * width + r.x, background + y * width + r.x, (size_t)r.w * 4);
  if (r.w > 0 && r.h > 0 && !full) wl_surface_damage(surface, r.x, r.y, r.w, r.h);
}
static void touch(struct rect r) {
  r = clip(r);
  if (r.w > 0 && r.h > 0 && !full) wl_surface_damage(surface, r.x, r.y, r.w, r.h);
}

static void draw(void) {
  repair(prev_ball);
  repair(prev_ptr);
  struct rect text = { 8, height - 18, width - 8, 14 };
  repair(text);
  prev_ball = (struct rect){ (int)bx - 8, (int)by - 8, 16, 16 };
  fill(prev_ball.x, prev_ball.y, 16, 16, 0xffe0b040);
  touch(prev_ball);
  prev_ptr = (struct rect){ 0, 0, 0, 0 };
  if (inside) {
    prev_ptr = (struct rect){ px - 6, py - 6, 12, 12 };
    fill(prev_ptr.x, prev_ptr.y, 12, 12, down ? 0xffff4040 : 0xff40ff80);
    touch(prev_ptr);
  }
  put_text(8, height - 18, last_key[0] ? last_key : "TYPE SOMETHING", 2, 0xffd0e0ff);
}

static void frame_done(void *data, struct wl_callback *cb, uint32_t time);
static const struct wl_callback_listener frame_listener = { frame_done };

static void new_buffer(void) {
  char path[256];
  snprintf(path, sizeof path, "%s/wldemo-XXXXXX", getenv("XDG_RUNTIME_DIR"));
  int fd = mkstemp(path);
  if (fd < 0) { fprintf(stderr, "wldemo: no shared memory (%d)\n", errno); exit(1); }
  unlink(path);
  size_t size = (size_t)width * height * 4;
  if (ftruncate(fd, (off_t)size) < 0) exit(1);
  if (pixels) munmap(pixels, pixels_size);
  pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED) exit(1);
  pixels_size = size;
  struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)size);
  if (buffer) wl_buffer_destroy(buffer);
  buffer = wl_shm_pool_create_buffer(pool, 0, width, height, width * 4, WL_SHM_FORMAT_XRGB8888);
  wl_shm_pool_destroy(pool);
  close(fd);
  draw_background();
}

static void present(void) {
  if (want_w && (want_w != width || want_h != height)) { width = want_w; height = want_h; new_buffer(); }
  bx += vx; by += vy;
  if (bx < 8 || bx > width - 8) { vx = -vx; bx += vx; }
  if (by < 8 || by > height - 8) { vy = -vy; by += vy; }
  draw();
  wl_surface_attach(surface, buffer, 0, 0);
  if (full) { wl_surface_damage(surface, 0, 0, width, height); full = 0; }
  frame = wl_surface_frame(surface);
  wl_callback_add_listener(frame, &frame_listener, NULL);
  wl_surface_commit(surface);
}
static void frame_done(void *data, struct wl_callback *cb, uint32_t time) {
  (void)data; (void)time;
  wl_callback_destroy(cb);
  frame = NULL;
  if (!closed) present();
}

static void registry_global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
  (void)data;
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
  xdg_surface_ack_configure(xs, serial);
  configured = 1;
}
static const struct xdg_surface_listener xs_listener = { xs_configure };
static void tl_configure(void *data, struct xdg_toplevel *tl, int32_t w, int32_t h, struct wl_array *states) {
  (void)data; (void)tl; (void)states;
  if (w > 0 && h > 0) { want_w = w; want_h = h; }
}
static void tl_close(void *data, struct xdg_toplevel *tl) { (void)data; (void)tl; closed = 1; }
static const struct xdg_toplevel_listener tl_listener = { tl_configure, tl_close, NULL, NULL };

static void ptr_enter(void *d, struct wl_pointer *p, uint32_t s, struct wl_surface *sf, wl_fixed_t x, wl_fixed_t y) { (void)d; (void)p; (void)s; (void)sf; inside = 1; px = wl_fixed_to_int(x); py = wl_fixed_to_int(y); }
static void ptr_leave(void *d, struct wl_pointer *p, uint32_t s, struct wl_surface *sf) { (void)d; (void)p; (void)s; (void)sf; inside = 0; down = 0; }
static void ptr_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) { (void)d; (void)p; (void)t; px = wl_fixed_to_int(x); py = wl_fixed_to_int(y); }
static void ptr_button(void *d, struct wl_pointer *p, uint32_t s, uint32_t t, uint32_t b, uint32_t state) { (void)d; (void)p; (void)s; (void)t; (void)b; down = state == WL_POINTER_BUTTON_STATE_PRESSED; }
static void ptr_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t a, wl_fixed_t v) { (void)d; (void)p; (void)t; (void)a; vx *= v > 0 ? 0.8f : 1.25f; vy *= v > 0 ? 0.8f : 1.25f; }
static void ptr_frame(void *d, struct wl_pointer *p) { (void)d; (void)p; }
static void ptr_axis_source(void *d, struct wl_pointer *p, uint32_t s) { (void)d; (void)p; (void)s; }
static void ptr_axis_stop(void *d, struct wl_pointer *p, uint32_t t, uint32_t a) { (void)d; (void)p; (void)t; (void)a; }
static void ptr_axis_discrete(void *d, struct wl_pointer *p, uint32_t a, int32_t v) { (void)d; (void)p; (void)a; (void)v; }
static const struct wl_pointer_listener ptr_listener = { ptr_enter, ptr_leave, ptr_motion, ptr_button, ptr_axis, ptr_frame, ptr_axis_source, ptr_axis_stop, ptr_axis_discrete };

static void kb_keymap(void *d, struct wl_keyboard *k, uint32_t format, int32_t fd, uint32_t size) {
  (void)d; (void)k; (void)format;
  char *text = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (text != MAP_FAILED) {
    if (!xkb) xkb = xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES | XKB_CONTEXT_NO_ENVIRONMENT_NAMES);
    keymap = xkb_keymap_new_from_buffer(xkb, text, size - 1, XKB_KEYMAP_FORMAT_TEXT_V1, XKB_KEYMAP_COMPILE_NO_FLAGS);
    xstate = keymap ? xkb_state_new(keymap) : NULL;
    munmap(text, size);
  }
  close(fd);
}
static void kb_enter(void *d, struct wl_keyboard *k, uint32_t s, struct wl_surface *sf, struct wl_array *keys) { (void)d; (void)k; (void)s; (void)sf; (void)keys; }
static void kb_leave(void *d, struct wl_keyboard *k, uint32_t s, struct wl_surface *sf) { (void)d; (void)k; (void)s; (void)sf; }
static void kb_key(void *d, struct wl_keyboard *k, uint32_t s, uint32_t t, uint32_t key, uint32_t state) {
  (void)d; (void)k; (void)s; (void)t;
  if (!xstate || state != WL_KEYBOARD_KEY_STATE_PRESSED) return;
  xkb_keysym_t sym = xkb_state_key_get_one_sym(xstate, key + 8);
  if (sym == XKB_KEY_Escape) { closed = 1; return; }
  char name[48];
  xkb_keysym_get_name(sym, name, sizeof name);
  snprintf(last_key, sizeof last_key, "%s", name);
}
static void kb_modifiers(void *d, struct wl_keyboard *k, uint32_t s, uint32_t dep, uint32_t lat, uint32_t lock, uint32_t group) { (void)d; (void)k; (void)s; if (xstate) xkb_state_update_mask(xstate, dep, lat, lock, 0, 0, group); }
static void kb_repeat(void *d, struct wl_keyboard *k, int32_t rate, int32_t delay) { (void)d; (void)k; (void)rate; (void)delay; }
static const struct wl_keyboard_listener kb_listener = { kb_keymap, kb_enter, kb_leave, kb_key, kb_modifiers, kb_repeat };

static void seat_caps(void *d, struct wl_seat *s, uint32_t caps) {
  (void)d;
  if (caps & WL_SEAT_CAPABILITY_POINTER) wl_pointer_add_listener(wl_seat_get_pointer(s), &ptr_listener, NULL);
  if (caps & WL_SEAT_CAPABILITY_KEYBOARD) wl_keyboard_add_listener(wl_seat_get_keyboard(s), &kb_listener, NULL);
}
static void seat_name(void *d, struct wl_seat *s, const char *n) { (void)d; (void)s; (void)n; }
static const struct wl_seat_listener seat_listener = { seat_caps, seat_name };

int main(int argc, char **argv) {
  if (argc > 2) { width = atoi(argv[1]); height = atoi(argv[2]); }
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {   /* the same default wlcomp listens in */
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) { fprintf(stderr, "wldemo: no Wayland display (is wlcomp running?)\n"); return 1; }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!compositor || !shm || !wm_base) { fprintf(stderr, "wldemo: the compositor lacks wl_compositor, wl_shm or xdg_wm_base\n"); return 1; }
  xdg_wm_base_add_listener(wm_base, &wm_listener, NULL);
  if (seat) { wl_seat_add_listener(seat, &seat_listener, NULL); wl_display_roundtrip(display); }
  surface = wl_compositor_create_surface(compositor);
  xsurface = xdg_wm_base_get_xdg_surface(wm_base, surface);
  xdg_surface_add_listener(xsurface, &xs_listener, NULL);
  struct xdg_toplevel *toplevel = xdg_surface_get_toplevel(xsurface);
  xdg_toplevel_add_listener(toplevel, &tl_listener, NULL);
  xdg_toplevel_set_title(toplevel, "wldemo");
  wl_surface_commit(surface);
  while (!configured && wl_display_dispatch(display) >= 0) {}
  new_buffer();
  present();
  while (!closed && wl_display_dispatch(display) >= 0) {}
  wl_display_disconnect(display);
  return 0;
}
