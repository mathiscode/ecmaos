/* SDL's 2D renderer on the driver asked for (opengles2 by default, or software): clears the window, fills a rectangle,
 * draws a texture made from a surface and a blended one, and prints the pixels SDL_RenderReadPixels gives back, then
 * presents and holds the window. Usage: sdl-render [DRIVER] [HOLD_MS]. Each check prints `ok` or `BAD` and what it read.
 * Needs wlcomp running. */
#include <SDL3/SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int bad;

static void expect(SDL_Surface *s, const char *what, int x, int y, int r, int g, int b) {
  Uint8 pr, pg, pb, pa;
  SDL_ReadSurfacePixel(s, x, y, &pr, &pg, &pb, &pa);
  /* blending rounds differently on a GPU: within 2 of what was asked */
  int ok = abs(pr - r) <= 2 && abs(pg - g) <= 2 && abs(pb - b) <= 2;
  if (!ok) bad = 1;
  printf("%s %s at %d,%d: %d %d %d\n", ok ? "ok" : "BAD", what, x, y, pr, pg, pb);
}

int main(int argc, char **argv) {
  const char *driver = argc > 1 ? argv[1] : "opengles2";
  int hold = argc > 2 ? atoi(argv[2]) : 0;
  setvbuf(stdout, NULL, _IOLBF, 0);
  /* without XDG_RUNTIME_DIR, /run/user/UID, as wlcomp and the SDL demos use */
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  if (!SDL_Init(SDL_INIT_VIDEO)) { printf("init failed: %s\n", SDL_GetError()); return 1; }
  printf("drivers");
  for (int i = 0; i < SDL_GetNumRenderDrivers(); i++) printf(" %s", SDL_GetRenderDriver(i));
  printf("\n");
  SDL_Window *win = SDL_CreateWindow("sdl-render", 64, 48, 0);
  if (!win) { printf("window failed: %s\n", SDL_GetError()); return 1; }
  SDL_Renderer *ren = SDL_CreateRenderer(win, driver);
  if (!ren) { printf("renderer failed: %s\n", SDL_GetError()); return 1; }
  printf("renderer %s\n", SDL_GetRendererName(ren));

  SDL_Surface *green = SDL_CreateSurface(8, 8, SDL_PIXELFORMAT_ARGB8888);
  SDL_FillSurfaceRect(green, NULL, SDL_MapSurfaceRGBA(green, 0, 200, 0, 255));
  SDL_Texture *tex = SDL_CreateTextureFromSurface(ren, green);
  SDL_Texture *half = SDL_CreateTextureFromSurface(ren, green);
  if (!tex || !half) { printf("texture failed: %s\n", SDL_GetError()); return 1; }
  SDL_SetTextureBlendMode(half, SDL_BLENDMODE_BLEND);
  SDL_SetTextureAlphaMod(half, 128);

  SDL_SetRenderDrawColor(ren, 10, 20, 30, 255);
  SDL_RenderClear(ren);
  SDL_SetRenderDrawColor(ren, 255, 0, 0, 255);
  SDL_RenderFillRect(ren, &(SDL_FRect){ 4, 4, 16, 16 });
  SDL_RenderTexture(ren, tex, NULL, &(SDL_FRect){ 24, 4, 16, 16 });
  /* half of green over the red rectangle's right half and the background */
  SDL_SetRenderDrawColor(ren, 255, 0, 0, 255);
  SDL_RenderFillRect(ren, &(SDL_FRect){ 4, 28, 16, 16 });
  SDL_RenderTexture(ren, half, NULL, &(SDL_FRect){ 12, 28, 16, 16 });

  SDL_Surface *got = SDL_RenderReadPixels(ren, NULL);
  if (!got) { printf("read failed: %s\n", SDL_GetError()); return 1; }
  printf("read %dx%d\n", got->w, got->h);
  expect(got, "clear", 60, 44, 10, 20, 30);
  expect(got, "fill", 10, 10, 255, 0, 0);
  expect(got, "texture", 30, 10, 0, 200, 0);
  expect(got, "blend over red", 16, 36, 127, 100, 0);
  expect(got, "blend over clear", 26, 36, 5, 110, 15);
  SDL_DestroySurface(got);
  SDL_RenderPresent(ren);
  printf("presented\n");

  Uint64 end = SDL_GetTicks() + (Uint64)hold;
  while (SDL_GetTicks() < end) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) if (e.type == SDL_EVENT_QUIT || e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) end = 0;
    SDL_Delay(10);
  }
  SDL_DestroyTexture(half);
  SDL_DestroyTexture(tex);
  SDL_DestroyRenderer(ren);
  SDL_DestroyWindow(win);
  SDL_Quit();
  printf(bad ? "failed\n" : "passed\n");
  return bad;
}
