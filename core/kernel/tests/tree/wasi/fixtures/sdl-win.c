/* A small SDL3 client for testing SDL's Wayland driver against wlcomp: opens a resizable window, paints a gradient
 * into the window surface, and prints what happens to it. Usage: sdl-win [WIDTH] [HEIGHT] [HOLD_MS]; Escape or a
 * close request ends it. */
#include <SDL3/SDL.h>
#include <stdio.h>
#include <stdlib.h>

static void paint(SDL_Surface *s, int shade) {
  SDL_LockSurface(s);
  for (int y = 0; y < s->h; y++) {
    Uint32 *row = (Uint32 *)((Uint8 *)s->pixels + y * s->pitch);
    for (int x = 0; x < s->w; x++) row[x] = 0xff000000u | ((x * 255 / s->w) << 16) | ((y * 255 / s->h) << 8) | (shade & 255);
  }
  SDL_UnlockSurface(s);
}

int main(int argc, char **argv) {
  int w = argc > 1 ? atoi(argv[1]) : 160, h = argc > 2 ? atoi(argv[2]) : 100, hold = argc > 3 ? atoi(argv[3]) : 0;
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (!SDL_Init(SDL_INIT_VIDEO)) { printf("init failed: %s\n", SDL_GetError()); return 1; }
  printf("driver %s\n", SDL_GetCurrentVideoDriver());
  SDL_Window *win = SDL_CreateWindow("sdl-win", w, h, SDL_WINDOW_RESIZABLE);
  if (!win) { printf("window failed: %s\n", SDL_GetError()); return 1; }
  SDL_StartTextInput(win);
  SDL_SetCursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_POINTER));   /* sent as a cursor shape */
  SDL_Surface *s = SDL_GetWindowSurface(win);
  if (!s) { printf("surface failed: %s\n", SDL_GetError()); return 1; }
  int painted_w = s->w, painted_h = s->h;
  paint(s, 60);
  SDL_UpdateWindowSurface(win);
  printf("shown %d %d\n", s->w, s->h);
  Uint64 end = SDL_GetTicks() + (Uint64)hold;
  int running = 1;
  while (running && SDL_GetTicks() < end) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      switch (e.type) {
      case SDL_EVENT_QUIT: case SDL_EVENT_WINDOW_CLOSE_REQUESTED: printf("close\n"); running = 0; break;
      case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
        s = SDL_GetWindowSurface(win);
        if (s->w == painted_w && s->h == painted_h) break;   /* the size SDL starts out with is not a resize */
        painted_w = s->w; painted_h = s->h;
        paint(s, 200);
        SDL_UpdateWindowSurface(win);
        printf("resized %d %d\n", s->w, s->h);
        break;
      case SDL_EVENT_WINDOW_MOUSE_ENTER: printf("mouse enter\n"); break;
      case SDL_EVENT_WINDOW_MOUSE_LEAVE: printf("mouse leave\n"); break;
      case SDL_EVENT_WINDOW_FOCUS_GAINED: printf("focus gained\n"); break;
      case SDL_EVENT_WINDOW_FOCUS_LOST: printf("focus lost\n"); break;
      case SDL_EVENT_MOUSE_MOTION: printf("motion %d %d\n", (int)e.motion.x, (int)e.motion.y); break;
      case SDL_EVENT_MOUSE_BUTTON_DOWN: case SDL_EVENT_MOUSE_BUTTON_UP: printf("button %d %d\n", e.button.button, e.button.down); break;
      case SDL_EVENT_KEY_DOWN: case SDL_EVENT_KEY_UP:
        printf("key %s %s\n", SDL_GetKeyName(e.key.key), e.key.down ? "down" : "up");
        if (e.key.down && e.key.key == SDLK_ESCAPE) running = 0;
        break;
      case SDL_EVENT_TEXT_INPUT: printf("text %s\n", e.text.text); break;
      }
    }
    SDL_Delay(10);
  }
  SDL_DestroyWindow(win);
  SDL_Quit();
  printf("exit\n");
  return 0;
}
