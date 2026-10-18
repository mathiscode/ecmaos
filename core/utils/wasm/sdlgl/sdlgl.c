/* SPDX-License-Identifier: MIT OR Apache-2.0
 * sdlgl: an OpenGL ES window for ecmaOS on SDL 3 (its Wayland driver, with OpenGL ES drawn by the browser's WebGL2
 * through /dev/gl<N>; see wasm/lib/sdl.sh and wasm/lib/sdl-gl). The window is cleared to a color each frame: R, G and B
 * set it to red, green or blue and Space to gray; it prints the GL strings when it starts and the color when it changes.
 * Escape or closing the window quits.
 * Usage: sdlgl [WIDTH] [HEIGHT]. Needs wlcomp running. Without XDG_RUNTIME_DIR it uses /run/user/UID, as wlcomp does. */
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengles2.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv)
{
  int w = argc > 1 ? atoi(argv[1]) : 320, h = argc > 2 ? atoi(argv[2]) : 240;
  if (w < 16 || h < 16) { fprintf(stderr, "usage: sdlgl [WIDTH] [HEIGHT]\n"); return 2; }
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  if (!SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "sdlgl: %s (is wlcomp running?)\n", SDL_GetError()); return 1; }
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 2);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
  SDL_Window *win = SDL_CreateWindow("sdlgl", w, h, SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE);
  if (!win) { fprintf(stderr, "sdlgl: %s\n", SDL_GetError()); return 1; }
  SDL_GLContext gl = SDL_GL_CreateContext(win);
  if (!gl) { fprintf(stderr, "sdlgl: %s\n", SDL_GetError()); return 1; }
  SDL_GL_SetSwapInterval(1);
  printf("sdlgl: %s, %s\n", (const char *)glGetString(GL_VERSION), (const char *)glGetString(GL_RENDERER));
  fflush(stdout);

  float color[3] = { 0.2f, 0.2f, 0.2f };
  for (int running = 1; running;) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_EVENT_QUIT || e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) running = 0;
      if (e.type == SDL_EVENT_KEY_DOWN) {
        SDL_Keycode key = e.key.key;
        if (key == SDLK_ESCAPE) running = 0;
        if (key == SDLK_R) { color[0] = 1; color[1] = color[2] = 0; printf("sdlgl: red\n"); }
        if (key == SDLK_G) { color[1] = 1; color[0] = color[2] = 0; printf("sdlgl: green\n"); }
        if (key == SDLK_B) { color[2] = 1; color[0] = color[1] = 0; printf("sdlgl: blue\n"); }
        if (key == SDLK_SPACE) { color[0] = color[1] = color[2] = 0.5f; printf("sdlgl: gray\n"); }
        fflush(stdout);
      }
    }
    int pw, ph;
    SDL_GetWindowSizeInPixels(win, &pw, &ph);
    glViewport(0, 0, pw, ph);
    glClearColor(color[0], color[1], color[2], 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    SDL_GL_SwapWindow(win);
    SDL_Delay(1);
  }
  SDL_GL_DestroyContext(gl);
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
