/* SPDX-License-Identifier: MIT OR Apache-2.0
 * sdlpaint: a small paint program for ecmaOS, written for this project on SDL 3 (its Wayland driver, see wasm/lib/sdl.sh).
 * Left button draws, right button erases; the wheel or [ and ] change the brush; 1-9 pick a color; C clears; F toggles
 * fullscreen; Escape or closing the window quits. The pointer is a crosshair over the picture and an arrow over the palette.
 * Usage: sdlpaint [WIDTH] [HEIGHT]. Needs wlcomp running. Without XDG_RUNTIME_DIR it uses /run/user/UID, as wlcomp does. */
#include <SDL3/SDL.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define BAR 32
#define SWATCH 24
#define NCOLORS 9

static const Uint32 palette[NCOLORS] = { 0x000000, 0xe53935, 0xfb8c00, 0xfdd835, 0x43a047, 0x1e88e5, 0x8e24aa, 0x6d4c41, 0xffffff };
static const Uint32 PAPER = 0xfafafa;

static SDL_Window *win;
static SDL_Surface *canvas;   /* the picture, as big as the area under the bar */
static SDL_Cursor *arrow, *cross;
static int color = 0, brush = 4, fullscreen, dirty = 1, over_bar;
static int last_x = -1, last_y = -1;

static Uint32 map(SDL_Surface *s, Uint32 rgb) { return SDL_MapSurfaceRGB(s, rgb >> 16, (rgb >> 8) & 255, rgb & 255); }

static void fill(SDL_Surface *s, int x, int y, int w, int h, Uint32 rgb) {
  SDL_Rect r = { x, y, w, h };
  SDL_FillSurfaceRect(s, &r, map(s, rgb));
}

static void dot(int cx, int cy, int r, Uint32 rgb) {
  for (int y = -r; y <= r; y++) {
    int span = 0;
    while ((span + 1) * (span + 1) + y * y <= r * r + r) span++;
    fill(canvas, cx - span, cy + y, span * 2 + 1, 1, rgb);
  }
  dirty = 1;
}

static void stroke(int x0, int y0, int x1, int y1, Uint32 rgb) {
  int n = abs(x1 - x0) > abs(y1 - y0) ? abs(x1 - x0) : abs(y1 - y0);
  if (n == 0) { dot(x0, y0, brush, rgb); return; }
  for (int i = 0; i <= n; i++) dot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, brush, rgb);
}

/* the picture follows the window: a bigger window gets paper, a smaller one crops, and what is drawn stays */
static void fit(int w, int h) {
  int ch = h > BAR ? h - BAR : 1;
  if (canvas && canvas->w == w && canvas->h == ch) return;
  SDL_Surface *next = SDL_CreateSurface(w, ch, SDL_PIXELFORMAT_XRGB8888);
  if (!next) return;
  SDL_FillSurfaceRect(next, NULL, map(next, PAPER));
  if (canvas) { SDL_BlitSurface(canvas, NULL, next, NULL); SDL_DestroySurface(canvas); }
  canvas = next;
  dirty = 1;
}

static void render(void) {
  SDL_Surface *s = SDL_GetWindowSurface(win);
  if (!s) return;
  fit(s->w, s->h);
  fill(s, 0, 0, s->w, BAR, 0x303030);
  for (int i = 0; i < NCOLORS; i++) {
    int x = 4 + i * (SWATCH + 4);
    if (i == color) fill(s, x - 3, 1, SWATCH + 6, BAR - 2, 0xffffff);
    fill(s, x, (BAR - SWATCH) / 2, SWATCH, SWATCH, palette[i]);
  }
  int bx = 4 + NCOLORS * (SWATCH + 4) + 12;
  fill(s, bx, 4, BAR - 8, BAR - 8, 0x303030);
  int r = brush > 12 ? 12 : brush;
  for (int y = -r; y <= r; y++) {
    int span = 0;
    while ((span + 1) * (span + 1) + y * y <= r * r + r) span++;
    fill(s, bx + (BAR - 8) / 2 - span, 4 + (BAR - 8) / 2 + y, span * 2 + 1, 1, 0xffffff);
  }
  SDL_Rect dst = { 0, BAR, 0, 0 };
  SDL_BlitSurface(canvas, NULL, s, &dst);
  SDL_UpdateWindowSurface(win);
  dirty = 0;
}

static int swatch_at(float x, float y) {
  if (y >= BAR) return -1;
  for (int i = 0; i < NCOLORS; i++) {
    int sx = 4 + i * (SWATCH + 4);
    if (x >= sx - 2 && x < sx + SWATCH + 2) return i;
  }
  return -1;
}

static void set_over(int bar) {
  if (bar == over_bar) return;
  over_bar = bar;
  SDL_SetCursor(bar ? arrow : cross);
}

int main(int argc, char **argv) {
  int w = argc > 1 ? atoi(argv[1]) : 480, h = argc > 2 ? atoi(argv[2]) : 360;
  if (w < 160) w = 160;
  if (h < 100) h = 100;
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  if (!SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "sdlpaint: %s\n", SDL_GetError()); return 1; }
  win = SDL_CreateWindow("sdlpaint", w, h, SDL_WINDOW_RESIZABLE);
  if (!win) { fprintf(stderr, "sdlpaint: %s\n", SDL_GetError()); SDL_Quit(); return 1; }
  arrow = SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_POINTER);
  cross = SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_CROSSHAIR);
  SDL_SetCursor(cross);
  int running = 1;
  while (running) {
    SDL_Event e;
    while (SDL_WaitEventTimeout(&e, dirty ? 0 : 50)) {
      switch (e.type) {
      case SDL_EVENT_QUIT: case SDL_EVENT_WINDOW_CLOSE_REQUESTED: running = 0; break;
      case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED: case SDL_EVENT_WINDOW_EXPOSED: dirty = 1; break;
      case SDL_EVENT_MOUSE_BUTTON_DOWN: {
        int i = swatch_at(e.button.x, e.button.y);
        if (i >= 0) { color = i; dirty = 1; break; }
        if (e.button.y < BAR) break;
        if (e.button.button == SDL_BUTTON_LEFT || e.button.button == SDL_BUTTON_RIGHT) {
          last_x = (int)e.button.x; last_y = (int)e.button.y - BAR;
          stroke(last_x, last_y, last_x, last_y, e.button.button == SDL_BUTTON_RIGHT ? PAPER : palette[color]);
        }
        break;
      }
      case SDL_EVENT_MOUSE_BUTTON_UP: last_x = last_y = -1; break;
      case SDL_EVENT_MOUSE_MOTION: {
        set_over(e.motion.y < BAR);
        if (last_x < 0 || e.motion.y < BAR) break;
        int x = (int)e.motion.x, y = (int)e.motion.y - BAR;
        if (e.motion.state & SDL_BUTTON_LMASK) stroke(last_x, last_y, x, y, palette[color]);
        else if (e.motion.state & SDL_BUTTON_RMASK) stroke(last_x, last_y, x, y, PAPER);
        else { last_x = last_y = -1; break; }
        last_x = x; last_y = y;
        break;
      }
      case SDL_EVENT_WINDOW_MOUSE_LEAVE: last_x = last_y = -1; break;
      case SDL_EVENT_MOUSE_WHEEL:
        brush += e.wheel.y > 0 ? 1 : e.wheel.y < 0 ? -1 : 0;
        if (brush < 1) brush = 1;
        if (brush > 40) brush = 40;
        dirty = 1;
        break;
      case SDL_EVENT_KEY_DOWN:
        if (e.key.key == SDLK_ESCAPE) running = 0;
        else if (e.key.key >= SDLK_1 && e.key.key <= SDLK_9) { color = e.key.key - SDLK_1; dirty = 1; }
        else if (e.key.key == SDLK_RIGHTBRACKET && brush < 40) { brush++; dirty = 1; }
        else if (e.key.key == SDLK_LEFTBRACKET && brush > 1) { brush--; dirty = 1; }
        else if (e.key.key == SDLK_C && canvas) { SDL_FillSurfaceRect(canvas, NULL, map(canvas, PAPER)); dirty = 1; }
        else if (e.key.key == SDLK_F) { fullscreen = !fullscreen; SDL_SetWindowFullscreen(win, fullscreen); }
        break;
      }
    }
    if (dirty) render();
  }
  if (canvas) SDL_DestroySurface(canvas);
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
