/* SPDX-License-Identifier: MIT OR Apache-2.0
 * sdlgl: an OpenGL ES window for ecmaOS on SDL 3 (its Wayland driver, with OpenGL ES drawn by the browser's WebGL2
 * through /dev/gl<N>; see wasm/lib/sdl.sh and wasm/lib/sdl-gl). A triangle with a red, a green and a blue corner turns
 * in front of a light, shaded by the angle it makes with it. The positions are in a buffer and the colors in the
 * program's memory, so both ways of giving GL an array are used. R, G and B set the color of the window behind it to red,
 * green or blue and Space to gray; P reads the pixel at the middle of the window back with glReadPixels and prints it. It
 * prints the GL strings when it starts, the shaders' logs if one does not build, and the color when it changes.
 * Escape or closing the window quits.
 * Usage: sdlgl [WIDTH] [HEIGHT]. Needs wlcomp running. Without XDG_RUNTIME_DIR it uses /run/user/UID, as wlcomp does. */
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengles2.h>
#include <stdio.h>
#include <math.h>
#include <stdlib.h>
#include <unistd.h>

static const char *vertex_source =
  "attribute vec3 aPos;\n"
  "attribute vec3 aColor;\n"
  "uniform mat4 uMvp;\n"
  "uniform mat3 uNormalMat;\n"
  "uniform vec3 uLight;\n"
  "varying vec3 vColor;\n"
  "void main() {\n"
  "  vec3 n = normalize(uNormalMat * vec3(0.0, 0.0, 1.0));\n"
  "  float lit = abs(dot(n, uLight));\n"
  "  vColor = aColor * (0.25 + 0.75 * lit);\n"
  "  gl_Position = uMvp * vec4(aPos, 1.0);\n"
  "}\n";
static const char *fragment_source =
  "precision mediump float;\n"
  "varying vec3 vColor;\n"
  "void main() { gl_FragColor = vec4(vColor, 1.0); }\n";

static GLuint compile(GLenum type, const char *source)
{
  GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, NULL);
  glCompileShader(shader);
  GLint ok = 0;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512];
    glGetShaderInfoLog(shader, sizeof log, NULL, log);
    fprintf(stderr, "sdlgl: shader: %s\n", log);
  }
  return shader;
}

/* column-major turn about Y by `y` then about X by `x`, with the horizontal squeezed to keep the shape on a wide window */
static void turn(float x, float y, float aspect, float mvp[16], float normal[9])
{
  const float cy = cosf(y), sy = sinf(y), cx = cosf(x), sx = sinf(x);
  const float r[9] = { cy, sx * sy, -cx * sy,   0, cx, sx,   sy, -sx * cy, cx * cy };   /* columns */
  for (int i = 0; i < 9; i++) normal[i] = r[i];
  const float scale = aspect > 1 ? 1.0f / aspect : 1.0f, scale_y = aspect > 1 ? 1.0f : aspect;
  const float m[16] = { r[0] * scale, r[1] * scale_y, r[2], 0,   r[3] * scale, r[4] * scale_y, r[5], 0,   r[6] * scale, r[7] * scale_y, r[8], 0,   0, 0, 0, 1 };
  for (int i = 0; i < 16; i++) mvp[i] = m[i];
}

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

  GLuint program = glCreateProgram();
  glAttachShader(program, compile(GL_VERTEX_SHADER, vertex_source));
  glAttachShader(program, compile(GL_FRAGMENT_SHADER, fragment_source));
  glBindAttribLocation(program, 0, "aPos");
  glBindAttribLocation(program, 1, "aColor");
  glLinkProgram(program);
  GLint linked = 0;
  glGetProgramiv(program, GL_LINK_STATUS, &linked);
  if (!linked) {
    char log[512];
    glGetProgramInfoLog(program, sizeof log, NULL, log);
    fprintf(stderr, "sdlgl: link: %s\n", log);
    return 1;
  }
  if (glGetAttribLocation(program, "aPos") != 0 || glGetAttribLocation(program, "aColor") != 1) { fprintf(stderr, "sdlgl: attribute locations differ from the ones bound\n"); return 1; }
  const GLint mvp_at = glGetUniformLocation(program, "uMvp"), normal_at = glGetUniformLocation(program, "uNormalMat"), light_at = glGetUniformLocation(program, "uLight");

  static const float positions[] = { 0.0f, 0.7f, 0.0f,   -0.7f, -0.5f, 0.0f,   0.7f, -0.5f, 0.0f };
  static const float colors[] = { 1, 0, 0,   0, 1, 0,   0, 0, 1 };
  GLuint vbo;
  glGenBuffers(1, &vbo);
  glBindBuffer(GL_ARRAY_BUFFER, vbo);
  glBufferData(GL_ARRAY_BUFFER, sizeof positions, positions, GL_STATIC_DRAW);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 0, (const void *)0);
  glEnableVertexAttribArray(0);
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 0, colors);
  glEnableVertexAttribArray(1);

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
        if (key == SDLK_P) {
          int pw, ph;
          SDL_GetWindowSizeInPixels(win, &pw, &ph);
          unsigned char px[4] = { 0, 0, 0, 0 };
          glReadPixels(pw / 2, ph / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
          printf("sdlgl: pixel %d %d %d\n", px[0], px[1], px[2]);
        }
        if (key == SDLK_SPACE) { color[0] = color[1] = color[2] = 0.5f; printf("sdlgl: gray\n"); }
        fflush(stdout);
      }
    }
    int pw, ph;
    SDL_GetWindowSizeInPixels(win, &pw, &ph);
    glViewport(0, 0, pw, ph);
    glClearColor(color[0], color[1], color[2], 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    float mvp[16], normal[9];
    turn(0.35f, (float)SDL_GetTicks() / 1000.0f, ph ? (float)pw / (float)ph : 1.0f, mvp, normal);
    glUseProgram(program);
    glUniformMatrix4fv(mvp_at, 1, GL_FALSE, mvp);
    glUniformMatrix3fv(normal_at, 1, GL_FALSE, normal);
    glUniform3f(light_at, 0.3f, 0.5f, 0.81f);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    SDL_GL_SwapWindow(win);
    SDL_Delay(1);
  }
  SDL_GL_DestroyContext(gl);
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
