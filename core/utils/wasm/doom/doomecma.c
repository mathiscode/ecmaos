/* SPDX-License-Identifier: GPL-2.0-or-later
 * doomecma: the platform layer that puts doomgeneric (id Software's Doom engine, see build.sh) in an ecmaOS window on
 * SDL 3 (its Wayland driver, see wasm/lib/sdl.sh). The engine draws 640x400 in 32 bit color into DG_ScreenBuffer; each
 * frame is scaled into the window's software surface, so the window can be resized. Keys follow Doom's own (Ctrl fires,
 * Space opens doors, Alt strafes, Shift runs). Escape opens the menu; closing the window quits.
 * Usage: doom [-iwad FILE] [engine options]. Needs wlcomp running. Without XDG_RUNTIME_DIR it uses /run/user/UID. */
#include <SDL3/SDL.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "doomkeys.h"
#include "doomgeneric.h"

static SDL_Window *window;
static SDL_Surface *frame;

#define KEYQUEUE_SIZE 64
static unsigned short key_queue[KEYQUEUE_SIZE];
static unsigned int key_write, key_read;

static unsigned char doom_key(SDL_Keycode key)
{
  switch (key) {
    case SDLK_RETURN: return KEY_ENTER;
    case SDLK_ESCAPE: return KEY_ESCAPE;
    case SDLK_TAB: return KEY_TAB;
    case SDLK_BACKSPACE: return KEY_BACKSPACE;
    case SDLK_LEFT: return KEY_LEFTARROW;
    case SDLK_RIGHT: return KEY_RIGHTARROW;
    case SDLK_UP: return KEY_UPARROW;
    case SDLK_DOWN: return KEY_DOWNARROW;
    case SDLK_LCTRL: case SDLK_RCTRL: return KEY_FIRE;
    case SDLK_SPACE: return KEY_USE;
    case SDLK_LSHIFT: case SDLK_RSHIFT: return KEY_RSHIFT;
    case SDLK_LALT: case SDLK_RALT: return KEY_LALT;
    case SDLK_F1: return KEY_F1;
    case SDLK_F2: return KEY_F2;
    case SDLK_F3: return KEY_F3;
    case SDLK_F4: return KEY_F4;
    case SDLK_F5: return KEY_F5;
    case SDLK_F6: return KEY_F6;
    case SDLK_F7: return KEY_F7;
    case SDLK_F8: return KEY_F8;
    case SDLK_F9: return KEY_F9;
    case SDLK_F10: return KEY_F10;
    case SDLK_F11: return KEY_F11;
    case SDLK_F12: return KEY_F12;
    case SDLK_PAUSE: return KEY_PAUSE;
    case SDLK_EQUALS: case SDLK_PLUS: return KEY_EQUALS;
    case SDLK_MINUS: return KEY_MINUS;
    default: return key < 128 ? (unsigned char)tolower((int)key) : 0;
  }
}

static void push_key(int pressed, SDL_Keycode sym)
{
  unsigned char key = doom_key(sym);
  if (!key) return;
  key_queue[key_write] = (unsigned short)((pressed << 8) | key);
  key_write = (key_write + 1) % KEYQUEUE_SIZE;
}

void DG_Init(void)
{
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  SDL_SetHint(SDL_HINT_FRAMEBUFFER_ACCELERATION, "0");   /* the window surface is the Wayland driver's own, not a renderer's texture */
  if (!SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "doom: %s (is wlcomp running?)\n", SDL_GetError()); exit(1); }
}

/* The window waits for the first frame: the engine reads the whole WAD before it draws, and a window that is not
 * answering the compositor for that long is not one it keeps. */
static void make_window(void)
{
  window = SDL_CreateWindow("DOOM", DOOMGENERIC_RESX, DOOMGENERIC_RESY, SDL_WINDOW_RESIZABLE);
  if (!window) { fprintf(stderr, "doom: %s\n", SDL_GetError()); exit(1); }
  frame = SDL_CreateSurfaceFrom(DOOMGENERIC_RESX, DOOMGENERIC_RESY, SDL_PIXELFORMAT_XRGB8888, DG_ScreenBuffer, DOOMGENERIC_RESX * 4);
  if (!frame) { fprintf(stderr, "doom: %s\n", SDL_GetError()); exit(1); }
}

void DG_DrawFrame(void)
{
  if (!window) make_window();
  SDL_Event e;
  while (SDL_PollEvent(&e)) {
    if (e.type == SDL_EVENT_QUIT || e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) exit(0);
    if (e.type == SDL_EVENT_KEY_DOWN && !e.key.repeat) push_key(1, e.key.key);
    if (e.type == SDL_EVENT_KEY_UP) push_key(0, e.key.key);
  }
  SDL_Surface *screen = SDL_GetWindowSurface(window);
  if (!screen) { fprintf(stderr, "doom: no window surface: %s\n", SDL_GetError()); return; }
  SDL_BlitSurfaceScaled(frame, NULL, screen, NULL, SDL_SCALEMODE_NEAREST);
  SDL_UpdateWindowSurface(window);
}

void DG_SleepMs(uint32_t ms) { SDL_Delay(ms); }
uint32_t DG_GetTicksMs(void) { return (uint32_t)SDL_GetTicks(); }

int DG_GetKey(int *pressed, unsigned char *key)
{
  if (key_read == key_write) return 0;
  unsigned short data = key_queue[key_read];
  key_read = (key_read + 1) % KEYQUEUE_SIZE;
  *pressed = data >> 8;
  *key = data & 0xff;
  return 1;
}

void DG_SetWindowTitle(const char *title) { if (window) SDL_SetWindowTitle(window, title); }

int main(int argc, char **argv)
{
  doomgeneric_Create(argc, argv);
  for (;;) doomgeneric_Tick();
}
