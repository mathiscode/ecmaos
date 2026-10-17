/* An SDL3 client for testing the clipboard and drops against wlcomp. Usage: sdl-clip [TEXT]. F1 puts TEXT on the clipboard,
 * F2 prints what the clipboard holds; clipboard changes and drops are printed as they come. Escape or a close request ends it. */
#include <SDL3/SDL.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  const char *mine = argc > 1 ? argv[1] : "from sdl-clip";
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (!SDL_Init(SDL_INIT_VIDEO)) { printf("init failed: %s\n", SDL_GetError()); return 1; }
  SDL_Window *win = SDL_CreateWindow("sdl-clip", 160, 100, 0);
  if (!win) { printf("window failed: %s\n", SDL_GetError()); return 1; }
  SDL_Surface *s = SDL_GetWindowSurface(win);
  if (!s) { printf("surface failed: %s\n", SDL_GetError()); return 1; }
  SDL_FillSurfaceRect(s, NULL, 0xff204060);
  SDL_UpdateWindowSurface(win);
  printf("shown\n");
  int running = 1;
  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      switch (e.type) {
      case SDL_EVENT_QUIT: case SDL_EVENT_WINDOW_CLOSE_REQUESTED: running = 0; break;
      case SDL_EVENT_WINDOW_FOCUS_GAINED: printf("focus gained\n"); break;
      case SDL_EVENT_KEY_DOWN:
        if (e.key.key == SDLK_ESCAPE) running = 0;
        if (e.key.key == SDLK_F1) { printf("set %d\n", SDL_SetClipboardText(mine)); }
        if (e.key.key == SDLK_F2) {
          char *text = SDL_GetClipboardText();
          printf("clipboard [%s] has=%d\n", text ? text : "(null)", SDL_HasClipboardText());
          SDL_free(text);
        }
        break;
      case SDL_EVENT_CLIPBOARD_UPDATE: printf("clipboard update owner=%d\n", e.clipboard.owner); break;
      case SDL_EVENT_DROP_BEGIN: printf("drop begin\n"); break;
      case SDL_EVENT_DROP_TEXT: printf("drop text [%s]\n", e.drop.data); break;
      case SDL_EVENT_DROP_FILE: printf("drop file [%s]\n", e.drop.data); break;
      case SDL_EVENT_DROP_COMPLETE: printf("drop complete\n"); break;
      }
    }
    SDL_Delay(10);
  }
  SDL_DestroyWindow(win);
  SDL_Quit();
  printf("exit\n");
  return 0;
}
