/* SPDX-License-Identifier: MIT OR Apache-2.0
 * sdlgears: three meshing gears for ecmaOS in OpenGL ES 2 on SDL 3 (its Wayland driver, drawn by the browser's WebGL2
 * through /dev/gl<N>; see wasm/lib/sdl.sh and wasm/lib/sdl-gl), after the classic glxgears. Each gear is a mesh in its own
 * buffer, lit by one light and depth tested. The arrow keys turn the view, Space pauses, Escape or closing the window quits.
 * It prints its frame rate every few seconds.
 * Usage: sdlgears [WIDTH] [HEIGHT]. Needs wlcomp running. Without XDG_RUNTIME_DIR it uses /run/user/UID, as wlcomp does. */
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengles2.h>
#include <stdio.h>
#include <math.h>
#include <stdlib.h>
#include <unistd.h>

static const char *vertex_source =
  "attribute vec3 aPos;\n"
  "attribute vec3 aNormal;\n"
  "uniform mat4 uModelView;\n"
  "uniform mat4 uProjection;\n"
  "uniform vec3 uColor;\n"
  "varying vec3 vColor;\n"
  "void main() {\n"
  "  vec3 n = normalize(mat3(uModelView[0].xyz, uModelView[1].xyz, uModelView[2].xyz) * aNormal);\n"
  "  float lit = max(dot(n, normalize(vec3(5.0, 5.0, 10.0))), 0.0);\n"
  "  vColor = uColor * (0.2 + 0.8 * lit);\n"
  "  gl_Position = uProjection * uModelView * vec4(aPos, 1.0);\n"
  "}\n";
static const char *fragment_source =
  "precision mediump float;\n"
  "varying vec3 vColor;\n"
  "void main() { gl_FragColor = vec4(vColor, 1.0); }\n";

typedef struct { float m[16]; } Mat;   /* column-major */

static Mat identity(void) { Mat r = {{ 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 }}; return r; }
static Mat multiply(Mat a, Mat b)
{
  Mat r;
  for (int c = 0; c < 4; c++) for (int row = 0; row < 4; row++) {
    float sum = 0;
    for (int k = 0; k < 4; k++) sum += a.m[k * 4 + row] * b.m[c * 4 + k];
    r.m[c * 4 + row] = sum;
  }
  return r;
}
static Mat translate(float x, float y, float z) { Mat r = identity(); r.m[12] = x; r.m[13] = y; r.m[14] = z; return r; }
static Mat rotate(float degrees, float x, float y, float z)
{
  const float a = degrees * (float)M_PI / 180.0f, c = cosf(a), s = sinf(a), t = 1 - c;
  Mat r = {{ t*x*x + c, t*x*y + s*z, t*x*z - s*y, 0,   t*x*y - s*z, t*y*y + c, t*y*z + s*x, 0,   t*x*z + s*y, t*y*z - s*x, t*z*z + c, 0,   0, 0, 0, 1 }};
  return r;
}
static Mat frustum(float left, float right, float bottom, float top, float near, float far)
{
  Mat r = {{ 2*near/(right-left), 0, 0, 0,   0, 2*near/(top-bottom), 0, 0,   (right+left)/(right-left), (top+bottom)/(top-bottom), -(far+near)/(far-near), -1,   0, 0, -2*far*near/(far-near), 0 }};
  return r;
}

typedef struct { GLuint buffer; int vertices; } Gear;

/* a gear of `teeth` teeth between radii `inner` and `outer`, `width` thick, as triangles of position and normal */
static Gear make_gear(float inner, float outer, float width, int teeth, float tooth_depth)
{
  const float r0 = inner, r1 = outer - tooth_depth / 2, r2 = outer + tooth_depth / 2, pitch = 2 * (float)M_PI / teeth, da = pitch / 4;
  float *v = malloc(sizeof(float) * 6 * 3 * 64 * (size_t)teeth);
  int n = 0;
#define VERT(x, y, z, nx, ny, nz) do { v[n++] = (x); v[n++] = (y); v[n++] = (z); v[n++] = (nx); v[n++] = (ny); v[n++] = (nz); } while (0)
#define QUAD(ax,ay,az, bx,by,bz, cx,cy,cz, dx,dy,dz, nx,ny,nz) do { \
    VERT(ax,ay,az,nx,ny,nz); VERT(bx,by,bz,nx,ny,nz); VERT(cx,cy,cz,nx,ny,nz); \
    VERT(ax,ay,az,nx,ny,nz); VERT(cx,cy,cz,nx,ny,nz); VERT(dx,dy,dz,nx,ny,nz); } while (0)
  const float h = width * 0.5f;
  for (int i = 0; i < teeth; i++) {
    const float a = i * pitch;
    const float c0 = cosf(a), s0 = sinf(a), c1 = cosf(a + da), s1 = sinf(a + da), c2 = cosf(a + 2 * da), s2 = sinf(a + 2 * da), c3 = cosf(a + 3 * da), s3 = sinf(a + 3 * da), c4 = cosf(a + 4 * da), s4 = sinf(a + 4 * da);
    for (int side = 0; side < 2; side++) {   /* front (+z) and back (-z) faces: the ring and the tooth top */
      const float z = side ? -h : h, nz = side ? -1.0f : 1.0f;
      QUAD(r0*c0, r0*s0, z,  r1*c0, r1*s0, z,  r1*c3, r1*s3, z,  r0*c4, r0*s4, z, 0, 0, nz);
      QUAD(r1*c0, r1*s0, z,  r2*c1, r2*s1, z,  r2*c2, r2*s2, z,  r1*c3, r1*s3, z, 0, 0, nz);
    }
    /* the sides of the tooth, the outside and the inner bore */
    float x, y, len;
    x = r2*s1 - r1*s0; y = -(r2*c1 - r1*c0); len = hypotf(x, y); x /= len; y /= len;
    QUAD(r1*c0, r1*s0, h,  r2*c1, r2*s1, h,  r2*c1, r2*s1, -h,  r1*c0, r1*s0, -h, x, y, 0);
    QUAD(r2*c1, r2*s1, h,  r2*c2, r2*s2, h,  r2*c2, r2*s2, -h,  r2*c1, r2*s1, -h, cosf(a + 1.5f*da), sinf(a + 1.5f*da), 0);
    x = r1*s3 - r2*s2; y = -(r1*c3 - r2*c2); len = hypotf(x, y); x /= len; y /= len;
    QUAD(r2*c2, r2*s2, h,  r1*c3, r1*s3, h,  r1*c3, r1*s3, -h,  r2*c2, r2*s2, -h, x, y, 0);
    QUAD(r1*c3, r1*s3, h,  r1*c4, r1*s4, h,  r1*c4, r1*s4, -h,  r1*c3, r1*s3, -h, cosf(a + 3.5f*da), sinf(a + 3.5f*da), 0);
    QUAD(r0*c4, r0*s4, h,  r0*c0, r0*s0, h,  r0*c0, r0*s0, -h,  r0*c4, r0*s4, -h, -cosf(a + 2*da), -sinf(a + 2*da), 0);   /* bore, facing in */
  }
  Gear gear = { 0, n / 6 };
  glGenBuffers(1, &gear.buffer);
  glBindBuffer(GL_ARRAY_BUFFER, gear.buffer);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(n * sizeof(float)), v, GL_STATIC_DRAW);
  free(v);
  return gear;
}

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
    fprintf(stderr, "sdlgears: shader: %s\n", log);
    exit(1);
  }
  return shader;
}

int main(int argc, char **argv)
{
  int w = argc > 1 ? atoi(argv[1]) : 300, h = argc > 2 ? atoi(argv[2]) : 300;
  if (w < 16 || h < 16) { fprintf(stderr, "usage: sdlgears [WIDTH] [HEIGHT]\n"); return 2; }
  if (!getenv("XDG_RUNTIME_DIR") || !*getenv("XDG_RUNTIME_DIR")) {
    char dir[64];
    snprintf(dir, sizeof dir, "/run/user/%d", (int)getuid());
    setenv("XDG_RUNTIME_DIR", dir, 1);
  }
  if (!SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "sdlgears: %s (is wlcomp running?)\n", SDL_GetError()); return 1; }
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 2);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 16);
  SDL_Window *win = SDL_CreateWindow("sdlgears", w, h, SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE);
  if (!win) { fprintf(stderr, "sdlgears: %s\n", SDL_GetError()); return 1; }
  SDL_GLContext gl = SDL_GL_CreateContext(win);
  if (!gl) { fprintf(stderr, "sdlgears: %s\n", SDL_GetError()); return 1; }
  SDL_GL_SetSwapInterval(1);
  printf("sdlgears: %s, %s\n", (const char *)glGetString(GL_VERSION), (const char *)glGetString(GL_RENDERER));
  fflush(stdout);

  GLuint program = glCreateProgram();
  glAttachShader(program, compile(GL_VERTEX_SHADER, vertex_source));
  glAttachShader(program, compile(GL_FRAGMENT_SHADER, fragment_source));
  glLinkProgram(program);
  GLint linked = 0;
  glGetProgramiv(program, GL_LINK_STATUS, &linked);
  if (!linked) {
    char log[512];
    glGetProgramInfoLog(program, sizeof log, NULL, log);
    fprintf(stderr, "sdlgears: link: %s\n", log);
    return 1;
  }
  const GLint pos_at = glGetAttribLocation(program, "aPos"), normal_at = glGetAttribLocation(program, "aNormal");
  const GLint view_at = glGetUniformLocation(program, "uModelView"), projection_at = glGetUniformLocation(program, "uProjection"), color_at = glGetUniformLocation(program, "uColor");
  if (pos_at < 0 || normal_at < 0) { fprintf(stderr, "sdlgears: the shader lacks its attributes\n"); return 1; }

  const Gear gears[3] = { make_gear(1.0f, 4.0f, 1.0f, 20, 0.7f), make_gear(0.5f, 2.0f, 2.0f, 10, 0.7f), make_gear(1.3f, 2.0f, 0.5f, 6, 0.7f) };
  const float colors[3][3] = { { 0.8f, 0.1f, 0.0f }, { 0.0f, 0.8f, 0.2f }, { 0.2f, 0.2f, 1.0f } };
  const float offsets[3][2] = { { -3.0f, -2.0f }, { 3.1f, -2.0f }, { -3.1f, 4.2f } };
  const float turns[3] = { 1.0f, -2.0f, -2.0f }, phases[3] = { 0.0f, -9.0f, -25.0f };

  glEnable(GL_DEPTH_TEST);
  float view_x = 20.0f, view_y = 30.0f, angle = 0.0f;
  int paused = 0, frames = 0;
  Uint64 last_ticks = SDL_GetTicks(), report = last_ticks;
  for (int running = 1; running;) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_EVENT_QUIT || e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) running = 0;
      if (e.type == SDL_EVENT_KEY_DOWN) {
        const SDL_Keycode key = e.key.key;
        if (key == SDLK_ESCAPE) running = 0;
        if (key == SDLK_SPACE) paused = !paused;
        if (key == SDLK_LEFT) view_y -= 5.0f;
        if (key == SDLK_RIGHT) view_y += 5.0f;
        if (key == SDLK_UP) view_x += 5.0f;
        if (key == SDLK_DOWN) view_x -= 5.0f;
      }
    }
    const Uint64 now = SDL_GetTicks();
    if (!paused) angle += (float)(now - last_ticks) * 0.09f;   /* 90 degrees a second for the big gear's pace */
    last_ticks = now;

    int pw, ph;
    SDL_GetWindowSizeInPixels(win, &pw, &ph);
    glViewport(0, 0, pw, ph);
    glClearColor(0.1f, 0.1f, 0.12f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    const float aspect = ph ? (float)pw / (float)ph : 1.0f;
    const Mat projection = frustum(-1.0f, 1.0f, -1.0f / aspect, 1.0f / aspect, 5.0f, 60.0f);
    Mat base = multiply(translate(0.0f, 0.0f, -40.0f), multiply(rotate(view_x, 1, 0, 0), rotate(view_y, 0, 1, 0)));
    glUseProgram(program);
    glUniformMatrix4fv(projection_at, 1, GL_FALSE, projection.m);
    for (int i = 0; i < 3; i++) {
      const Mat model = multiply(base, multiply(translate(offsets[i][0], offsets[i][1], 0.0f), rotate(turns[i] * angle + phases[i], 0, 0, 1)));
      glUniformMatrix4fv(view_at, 1, GL_FALSE, model.m);
      glUniform3fv(color_at, 1, colors[i]);
      glBindBuffer(GL_ARRAY_BUFFER, gears[i].buffer);
      glVertexAttribPointer((GLuint)pos_at, 3, GL_FLOAT, GL_FALSE, 24, (const void *)0);
      glEnableVertexAttribArray((GLuint)pos_at);
      glVertexAttribPointer((GLuint)normal_at, 3, GL_FLOAT, GL_FALSE, 24, (const void *)12);
      glEnableVertexAttribArray((GLuint)normal_at);
      glDrawArrays(GL_TRIANGLES, 0, gears[i].vertices);
    }
    SDL_GL_SwapWindow(win);
    frames++;
    if (now - report >= 5000) {
      printf("sdlgears: %d frames in %.1f seconds = %.1f FPS\n", frames, (double)(now - report) / 1000.0, frames * 1000.0 / (double)(now - report));
      fflush(stdout);
      frames = 0;
      report = now;
    }
    SDL_Delay(1);
  }
  SDL_GL_DestroyContext(gl);
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
