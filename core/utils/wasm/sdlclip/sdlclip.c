/* SPDX-License-Identifier: MIT OR Apache-2.0
 * sdlclip: a window that shows the clipboard and what is dropped on it, written for ecmaOS on SDL 3 (its Wayland driver,
 * see wasm/lib/sdl.sh). C puts a line of text on the clipboard, V reads it again, Escape or closing the window quits.
 * Text copied in the browser (or in another program under wlcomp) shows up here; text or links dragged onto the window
 * from the page are listed. Letters and digits are all the font draws.
 * Usage: sdlclip [WIDTH] [HEIGHT]. Needs wlcomp running. Without XDG_RUNTIME_DIR it uses /run/user/UID, as wlcomp does. */
#include <SDL3/SDL.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* 5x7 glyphs, one byte a row, the low five bits: 0-9 then A-Z. */
static const uint8_t font[36][7] = {
  {14,17,19,21,25,17,14},{4,12,4,4,4,4,14},{14,17,1,2,4,8,31},{14,17,1,6,1,17,14},{2,6,10,18,31,2,2},{31,16,30,1,1,17,14},{6,8,16,30,17,17,14},{31,1,2,4,8,8,8},{14,17,17,14,17,17,14},{14,17,17,15,1,2,12},
  {14,17,17,31,17,17,17},{30,17,17,30,17,17,30},{14,17,16,16,16,17,14},{30,17,17,17,17,17,30},{31,16,16,30,16,16,31},{31,16,16,30,16,16,16},{14,17,16,23,17,17,15},{17,17,17,31,17,17,17},{14,4,4,4,4,4,14},{7,2,2,2,2,18,12},{17,18,20,24,20,18,17},{16,16,16,16,16,16,31},{17,27,21,21,17,17,17},{17,17,25,21,19,17,17},{14,17,17,17,17,17,14},{30,17,17,30,16,16,16},{14,17,17,17,21,18,13},{30,17,17,30,20,18,17},{15,16,16,14,1,1,30},{31,4,4,4,4,4,4},{17,17,17,17,17,17,14},{17,17,17,17,17,10,4},{17,17,17,21,21,27,17},{17,17,10,4,10,17,17},{17,17,10,4,4,4,4},{31,1,2,4,8,16,31}
};

#define LINES 6
#define COLS 40
#define DROPS 6

static char clip[LINES][COLS + 1];
static int clip_lines, clip_chars, clip_owner;
static char drops[DROPS][COLS + 1];
static int ndrops, copies;

static void rect(SDL_Surface *s, int x, int y, int w, int h, Uint32 rgb) {
  SDL_Rect r = { x, y, w, h };
  SDL_FillSurfaceRect(s, &r, SDL_MapSurfaceRGB(s, rgb >> 16, (rgb >> 8) & 255, rgb & 255));
}

static int glyph(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'A' && c <= 'Z' ? 10 + c - 'A' : c >= 'a' && c <= 'z' ? 10 + c - 'a' : -1; }

static void text(SDL_Surface *s, int x, int y, const char *t, int k, Uint32 rgb) {
  for (; *t; t++, x += 6 * k) {
    int g = glyph(*t);
    if (g < 0) continue;
    for (int r = 0; r < 7; r++) for (int c = 0; c < 5; c++) if (font[g][r] & (16 >> c)) rect(s, x + c * k, y + r * k, k, k, rgb);
  }
}

/* what the clipboard holds, cut into lines of COLS characters */
static void read_clipboard(void) {
  clip_lines = clip_chars = 0;
  char *t = SDL_HasClipboardText() ? SDL_GetClipboardText() : NULL;
  if (!t) return;
  clip_chars = (int)strlen(t);
  for (const char *p = t; *p && clip_lines < LINES;) {
    int n = 0;
    while (p[n] && p[n] != 10 && n < COLS) n++;
    memcpy(clip[clip_lines], p, (size_t)n);
    clip[clip_lines++][n] = 0;
    p += n;
    if (*p == 10) p++;
    else if (*p == 13) { p++; if (*p == 10) p++; }
  }
  SDL_free(t);
}

static void add_drop(const char *kind, const char *data) {
  if (ndrops == DROPS) { memmove(drops[0], drops[1], (DROPS - 1) * (COLS + 1)); ndrops--; }
  snprintf(drops[ndrops++], COLS + 1, "%s %s", kind, data);
}

static void draw(SDL_Surface *s) {
  int k = s->w >= 400 ? 2 : 1, line = 10 * k, y = 8;
  rect(s, 0, 0, s->w, s->h, 0x14161c);
  text(s, 8, y, "SDLCLIP", k, 0xe6e8ee);
  text(s, 8 + 8 * 6 * k, y, "C COPY   V PASTE   ESC QUIT", k, 0x9aa1b2);
  y += line * 2;
  char buf[64];
  snprintf(buf, sizeof buf, "CLIPBOARD %d CHARS%s", clip_chars, clip_owner ? " (OURS)" : "");
  text(s, 8, y, buf, k, 0x6ee7a1);
  y += line;
  rect(s, 8, y, s->w - 16, line * LINES + 4, 0x1d2129);
  for (int i = 0; i < clip_lines; i++) text(s, 12, y + 2 + i * line, clip[i], k, 0xe6e8ee);
  y += line * LINES + 4 + line;
  text(s, 8, y, "DROPPED ON THE WINDOW", k, 0xe5484d);
  y += line;
  rect(s, 8, y, s->w - 16, line * DROPS + 4, 0x1d2129);
  for (int i = 0; i < ndrops; i++) text(s, 12, y + 2 + i * line, drops[i], k, 0xe6e8ee);
}

int main(int argc, char **argv) {
  int w = argc > 1 ? atoi(argv[1]) : 520, h = argc > 2 ? atoi(argv[2]) : 340;
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {   /* the same default wlcomp listens in */
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  if (w < 200) w = 200;
  if (h < 200) h = 200;
  if (!SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "sdlclip: %s (is wlcomp running?)\n", SDL_GetError()); return 1; }
  SDL_Window *win = SDL_CreateWindow("sdlclip", w, h, SDL_WINDOW_RESIZABLE);
  if (!win) { fprintf(stderr, "sdlclip: %s\n", SDL_GetError()); return 1; }
  read_clipboard();
  int running = 1, dirty = 1;
  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      switch (e.type) {
      case SDL_EVENT_QUIT: case SDL_EVENT_WINDOW_CLOSE_REQUESTED: running = 0; break;
      case SDL_EVENT_KEY_DOWN:
        if (e.key.repeat) break;
        if (e.key.key == SDLK_ESCAPE) running = 0;
        else if (e.key.key == SDLK_C) { char t[48]; snprintf(t, sizeof t, "hello from sdlclip %d", ++copies); SDL_SetClipboardText(t); clip_owner = 1; read_clipboard(); }
        else if (e.key.key == SDLK_V) read_clipboard();
        dirty = 1;
        break;
      case SDL_EVENT_CLIPBOARD_UPDATE: clip_owner = e.clipboard.owner; read_clipboard(); dirty = 1; break;
      case SDL_EVENT_DROP_TEXT: add_drop("TEXT", e.drop.data); dirty = 1; break;
      case SDL_EVENT_DROP_FILE: add_drop("FILE", e.drop.data); dirty = 1; break;
      case SDL_EVENT_WINDOW_EXPOSED: case SDL_EVENT_WINDOW_RESIZED: case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED: dirty = 1; break;
      }
    }
    if (dirty) {
      SDL_Surface *s = SDL_GetWindowSurface(win);
      if (s) { draw(s); SDL_UpdateWindowSurface(win); }
      dirty = 0;
    }
    SDL_Delay(20);
  }
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
