/* SPDX-License-Identifier: MIT OR Apache-2.0
 * sdlpad: shows a gamepad, written for ecmaOS on SDL 3 (its Wayland driver and its joystick driver, which reads the
 * browser's pads from /dev/js0 to /dev/js3; see wasm/lib/sdl.sh). A square for each button lights while it is held, a
 * bar for each axis has a marker that moves with the stick. The browser shows a pad only once a button has been
 * pressed on it. A pad with the standard layout also prints the name of each button as it goes down or up. Escape or
 * closing the window quits. Letters and digits are all the font draws.
 * Usage: sdlpad [WIDTH] [HEIGHT]. Needs wlcomp running. Without XDG_RUNTIME_DIR it uses /run/user/UID, as wlcomp does. */
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

#define MAX_BUTTONS 32
#define MAX_AXES 8

static SDL_Joystick *joy;
static SDL_Gamepad *pad;
static SDL_JoystickID joy_id;

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

static void close_pad(void) {
  if (pad) SDL_CloseGamepad(pad);
  else if (joy) SDL_CloseJoystick(joy);
  pad = NULL; joy = NULL; joy_id = 0;
}

static void open_first(void) {
  if (joy) return;
  int n = 0;
  SDL_JoystickID *ids = SDL_GetJoysticks(&n);
  if (!ids) return;
  if (n > 0) {
    joy_id = ids[0];
    if (SDL_IsGamepad(joy_id)) { pad = SDL_OpenGamepad(joy_id); if (pad) joy = SDL_GetGamepadJoystick(pad); }
    else joy = SDL_OpenJoystick(joy_id);
    if (joy) printf("sdlpad: %s, %d buttons, %d axes%s\n", SDL_GetJoystickName(joy), SDL_GetNumJoystickButtons(joy), SDL_GetNumJoystickAxes(joy), pad ? ", standard layout" : "");
    else joy_id = 0;
    fflush(stdout);
  }
  SDL_free(ids);
}

static void draw(SDL_Surface *s) {
  rect(s, 0, 0, s->w, s->h, 0x1b1d23);
  if (!joy) { text(s, 12, 12, "NO GAMEPAD", 3, 0xc8ccd4); text(s, 12, 44, "PRESS A BUTTON ON ONE", 2, 0x8a909c); return; }
  text(s, 12, 12, SDL_GetJoystickName(joy), 2, 0xc8ccd4);
  int nb = SDL_GetNumJoystickButtons(joy), na = SDL_GetNumJoystickAxes(joy);
  if (nb > MAX_BUTTONS) nb = MAX_BUTTONS;
  if (na > MAX_AXES) na = MAX_AXES;
  int cell = 28, per = (s->w - 24) / cell;
  if (per < 1) per = 1;
  for (int i = 0; i < nb; i++) {
    int x = 12 + (i % per) * cell, y = 44 + (i / per) * cell;
    rect(s, x, y, cell - 4, cell - 4, SDL_GetJoystickButton(joy, i) ? 0x4ec27a : 0x30343d);
  }
  int top = 44 + ((nb + per - 1) / per) * cell + 12, bar = s->w - 24;
  for (int i = 0; i < na; i++) {
    int y = top + i * 22;
    rect(s, 12, y, bar, 14, 0x30343d);
    rect(s, 12 + bar / 2 - 1, y, 2, 14, 0x555b68);
    int v = SDL_GetJoystickAxis(joy, i);
    int x = 12 + (int)((long)(v + 32768) * (bar - 10) / 65535);
    rect(s, x, y, 10, 14, v ? 0xe0a63c : 0x8a909c);
  }
}

int main(int argc, char **argv) {
  int w = argc > 1 ? atoi(argv[1]) : 360, h = argc > 2 ? atoi(argv[2]) : 300;
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  if (w < 200) w = 200;
  if (h < 160) h = 160;
  SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");   /* a viewer: show the pad even when another window has the focus */
  if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD)) { fprintf(stderr, "sdlpad: %s (is wlcomp running?)\n", SDL_GetError()); return 1; }
  SDL_Window *win = SDL_CreateWindow("sdlpad", w, h, SDL_WINDOW_RESIZABLE);
  if (!win) { fprintf(stderr, "sdlpad: %s\n", SDL_GetError()); return 1; }
  int running = 1, dirty = 1;
  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      switch (e.type) {
      case SDL_EVENT_QUIT: case SDL_EVENT_WINDOW_CLOSE_REQUESTED: running = 0; break;
      case SDL_EVENT_KEY_DOWN: if (e.key.key == SDLK_ESCAPE) running = 0; break;
      case SDL_EVENT_JOYSTICK_ADDED: open_first(); dirty = 1; break;
      case SDL_EVENT_JOYSTICK_REMOVED:
        if (e.jdevice.which == joy_id) { printf("sdlpad: gamepad gone\n"); fflush(stdout); close_pad(); open_first(); }
        dirty = 1;
        break;
      case SDL_EVENT_JOYSTICK_BUTTON_DOWN: case SDL_EVENT_JOYSTICK_BUTTON_UP: case SDL_EVENT_JOYSTICK_AXIS_MOTION: dirty = 1; break;
      case SDL_EVENT_GAMEPAD_BUTTON_DOWN: case SDL_EVENT_GAMEPAD_BUTTON_UP:
        printf("sdlpad: %s %s\n", SDL_GetGamepadStringForButton((SDL_GamepadButton)e.gbutton.button), e.gbutton.down ? "down" : "up");
        fflush(stdout);
        break;
      case SDL_EVENT_WINDOW_EXPOSED: case SDL_EVENT_WINDOW_RESIZED: case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED: dirty = 1; break;
      }
    }
    if (dirty) {
      SDL_Surface *s = SDL_GetWindowSurface(win);
      if (s) { draw(s); SDL_UpdateWindowSurface(win); }
      dirty = 0;
    }
    SDL_Delay(16);
  }
  close_pad();
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
