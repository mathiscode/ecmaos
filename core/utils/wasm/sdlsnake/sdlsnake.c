/* SPDX-License-Identifier: MIT OR Apache-2.0
 * sdlsnake: Snake for ecmaOS, written for this project on SDL 3 (its Wayland driver, see wasm/lib/sdl.sh). A
 * resizable window; arrows or WASD steer, P pauses, R restarts, Escape or closing the window quits.
 * Usage: sdlsnake [WIDTH] [HEIGHT]. Needs wlcomp running. */
#include <SDL3/SDL.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define COLS 24
#define ROWS 16
#define MAXLEN (COLS * ROWS)

/* 5x7 glyphs, one byte a row, the low five bits: 0-9 then A-Z. */
static const uint8_t font[36][7] = {
  {14,17,19,21,25,17,14},{4,12,4,4,4,4,14},{14,17,1,2,4,8,31},{14,17,1,6,1,17,14},{2,6,10,18,31,2,2},{31,16,30,1,1,17,14},{6,8,16,30,17,17,14},{31,1,2,4,8,8,8},{14,17,17,14,17,17,14},{14,17,17,15,1,2,12},
  {14,17,17,31,17,17,17},{30,17,17,30,17,17,30},{14,17,16,16,16,17,14},{30,17,17,17,17,17,30},{31,16,16,30,16,16,31},{31,16,16,30,16,16,16},{14,17,16,23,17,17,15},{17,17,17,31,17,17,17},{14,4,4,4,4,4,14},{7,2,2,2,2,18,12},{17,18,20,24,20,18,17},{16,16,16,16,16,16,31},{17,27,21,21,17,17,17},{17,17,25,21,19,17,17},{14,17,17,17,17,17,14},{30,17,17,30,16,16,16},{14,17,17,17,21,18,13},{30,17,17,30,20,18,17},{15,16,16,14,1,1,30},{31,4,4,4,4,4,4},{17,17,17,17,17,17,14},{17,17,17,17,17,10,4},{17,17,17,21,21,27,17},{17,17,10,4,10,17,17},{17,17,10,4,4,4,4},{31,1,2,4,8,16,31}
};

static int sx[MAXLEN], sy[MAXLEN], len, dx, dy, qdx, qdy, fx, fy, score, best, over, paused;

static void place_food(void) {
  for (;;) {
    fx = rand() % COLS; fy = rand() % ROWS;
    int hit = 0;
    for (int i = 0; i < len; i++) if (sx[i] == fx && sy[i] == fy) { hit = 1; break; }
    if (!hit) return;
  }
}

static void restart(void) {
  len = 3; dx = qdx = 1; dy = qdy = 0; score = 0; over = paused = 0;
  for (int i = 0; i < len; i++) { sx[i] = COLS / 2 - i; sy[i] = ROWS / 2; }
  place_food();
}

static void step(void) {
  dx = qdx; dy = qdy;
  int nx = sx[0] + dx, ny = sy[0] + dy;
  int eat = nx == fx && ny == fy;
  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) { over = 1; return; }
  for (int i = 0; i < len - (eat ? 0 : 1); i++) if (sx[i] == nx && sy[i] == ny) { over = 1; return; }
  if (eat && len < MAXLEN) len++;
  for (int i = len - 1; i > 0; i--) { sx[i] = sx[i - 1]; sy[i] = sy[i - 1]; }
  sx[0] = nx; sy[0] = ny;
  if (eat) { score++; if (score > best) best = score; if (len < MAXLEN) place_food(); else over = 1; }
}

static void rect(SDL_Surface *s, int x, int y, int w, int h, Uint32 rgb) {
  SDL_Rect r = { x, y, w, h };
  SDL_FillSurfaceRect(s, &r, SDL_MapSurfaceRGB(s, rgb >> 16, (rgb >> 8) & 255, rgb & 255));
}

static int glyph(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'A' && c <= 'Z' ? 10 + c - 'A' : c >= 'a' && c <= 'z' ? 10 + c - 'a' : -1; }

static int text_w(const char *t, int k) { int n = 0; for (; *t; t++) n++; return n ? n * 6 * k - k : 0; }

static void text(SDL_Surface *s, int x, int y, const char *t, int k, Uint32 rgb) {
  for (; *t; t++, x += 6 * k) {
    int g = glyph(*t);
    if (g < 0) continue;
    for (int r = 0; r < 7; r++) for (int c = 0; c < 5; c++) if (font[g][r] & (16 >> c)) rect(s, x + c * k, y + r * k, k, k, rgb);
  }
}

static void draw(SDL_Surface *s) {
  int bar = s->h / 12 < 14 ? 14 : s->h / 12;
  int cell = (s->h - bar) / ROWS, cw = s->w / COLS;
  if (cw < cell) cell = cw;
  if (cell < 1) cell = 1;
  int ox = (s->w - cell * COLS) / 2, oy = bar + (s->h - bar - cell * ROWS) / 2;
  rect(s, 0, 0, s->w, s->h, 0x14161c);
  rect(s, ox, oy, cell * COLS, cell * ROWS, 0x1d2129);
  rect(s, ox + fx * cell + 1, oy + fy * cell + 1, cell - 2, cell - 2, 0xe5484d);
  for (int i = len - 1; i >= 0; i--) rect(s, ox + sx[i] * cell + 1, oy + sy[i] * cell + 1, cell - 2, cell - 2, i ? 0x30a46c : 0x6ee7a1);
  char buf[48];
  int k = bar / 9 < 1 ? 1 : bar / 9;
  snprintf(buf, sizeof buf, "SCORE %d", score);
  text(s, 6, (bar - 7 * k) / 2, buf, k, 0xe6e8ee);
  snprintf(buf, sizeof buf, "BEST %d", best);
  text(s, s->w - text_w(buf, k) - 6, (bar - 7 * k) / 2, buf, k, 0x9aa1b2);
  if (over || paused) {
    const char *m = over ? "GAME OVER" : "PAUSED";
    int mk = s->w / 120 < 1 ? 1 : s->w / 120;
    int mw = text_w(m, mk);
    rect(s, (s->w - mw) / 2 - 8 * mk, s->h / 2 - 8 * mk, mw + 16 * mk, 14 * mk + (over ? 10 * mk : 0), 0x000000);
    text(s, (s->w - mw) / 2, s->h / 2 - 4 * mk, m, mk, 0xffffff);
    if (over) text(s, (s->w - text_w("R RESTARTS", mk)) / 2, s->h / 2 + 8 * mk, "R RESTARTS", mk, 0x9aa1b2);
  }
}

int main(int argc, char **argv) {
  int w = argc > 1 ? atoi(argv[1]) : 480, h = argc > 2 ? atoi(argv[2]) : 340;
  if (w < 120) w = 120;
  if (h < 90) h = 90;
  if (!SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "sdlsnake: %s (is wlcomp running?)\n", SDL_GetError()); return 1; }
  SDL_Window *win = SDL_CreateWindow("sdlsnake", w, h, SDL_WINDOW_RESIZABLE);
  if (!win) { fprintf(stderr, "sdlsnake: %s\n", SDL_GetError()); return 1; }
  srand((unsigned)SDL_GetTicks());
  restart();
  Uint64 next = SDL_GetTicks();
  int running = 1;
  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_EVENT_QUIT || e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) running = 0;
      else if (e.type == SDL_EVENT_KEY_DOWN && !e.key.repeat) {
        switch (e.key.key) {
        case SDLK_ESCAPE: running = 0; break;
        case SDLK_UP: case SDLK_W: if (dy == 0) { qdx = 0; qdy = -1; } break;
        case SDLK_DOWN: case SDLK_S: if (dy == 0) { qdx = 0; qdy = 1; } break;
        case SDLK_LEFT: case SDLK_A: if (dx == 0) { qdx = -1; qdy = 0; } break;
        case SDLK_RIGHT: case SDLK_D: if (dx == 0) { qdx = 1; qdy = 0; } break;
        case SDLK_P: case SDLK_SPACE: if (!over) paused = !paused; break;
        case SDLK_R: restart(); break;
        }
      }
    }
    Uint64 now = SDL_GetTicks();
    if (!over && !paused) {
      int period = 150 - score * 4 < 60 ? 60 : 150 - score * 4;
      while (now >= next) { step(); next += period; if (over) break; }
    } else next = now;
    SDL_Surface *s = SDL_GetWindowSurface(win);
    if (s) { draw(s); SDL_UpdateWindowSurface(win); }
    SDL_Delay(33);
  }
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
