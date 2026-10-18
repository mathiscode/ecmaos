/*
  OpenGL ES for SDL on ecmaOS. Added to SDL's source tree by lib/sdl.sh; it is not part of SDL.

  SDL's Wayland driver draws OpenGL ES through EGL, which would be a GPU driver. Here the "GPU" is the browser's
  WebGL2, reached through the kernel's /dev/gl<N> (core/kernel/src/tree/lib/gl.ts): this file is the EGL and GLES2
  that SDL is linked with. Calls are packed into a command stream (ecmaos_gl_cmds.inc, generated from
  gl-commands.json), written to the context's node when it grows or a frame is asked for, and the picture comes back
  as pixels: eglSwapBuffers reads it into a wl_shm buffer and commits it, which is how a software client shows a
  window to the compositor.
*/
#include "SDL_internal.h"

#if defined(SDL_VIDEO_DRIVER_WAYLAND) && defined(SDL_VIDEO_OPENGL_EGL)

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include "../SDL_sysvideo.h"
#include "../SDL_egl_c.h"
#include "../wayland/SDL_waylandvideo.h"
#include <SDL3/SDL_opengles2.h>
#include <wayland-egl-backend.h>

extern int Wayland_CreateTempFD(off_t size);

#define GLCTL_CREATE 0x47c0
#define GL_SWAP_REQUEST 0x4700
#define GL_RESIZE_REQUEST 0x4701
#define GL_GETINFO_REQUEST 0x4702
#define GL_DESTROY_REQUEST 0x4703

#define ECMAOS_CONFIG ((EGLConfig)1)
#define ECMAOS_DISPLAY_FALLBACK ((EGLDisplay)1)
#define FLUSH_AT 65536

typedef struct
{
    int fd;
    int width, height;
    Uint8 *stream;
    size_t used, capacity;
} Context;

typedef struct
{
    struct wl_buffer *buffer;
    void *pixels;
    bool busy;
} Slot;

typedef struct
{
    struct wl_egl_window *window;
    int width, height;
    struct wl_shm_pool *pool;
    void *memory;
    size_t memory_size;
    Slot slots[2];
    int next;
} Surface;

static EGLint last_error = EGL_SUCCESS;
static Context *current;

static bool fail(EGLint error)
{
    last_error = error;
    return false;
}

static uint32_t ecmaos_f2u(float f)
{
    uint32_t u;
    memcpy(&u, &f, 4);
    return u;
}

// - the command stream ---------------------------------------------------------------------------------

static bool flush_stream(Context *c)
{
    size_t done = 0;
    while (done < c->used) {
        const ssize_t n = write(c->fd, c->stream + done, c->used - done);
        if (n <= 0) {
            c->used = 0;
            return false;
        }
        done += (size_t)n;
    }
    c->used = 0;
    return true;
}

static void ecmaos_emit(unsigned op, unsigned count, const uint32_t *words)
{
    Context *c = current;
    const size_t need = 4 + (size_t)count * 4;
    if (!c) {
        return; // GL calls with no current context do nothing
    }
    if (c->used + need > c->capacity) {
        const size_t capacity = c->capacity ? c->capacity * 2 : 4096;
        Uint8 *grown = (Uint8 *)SDL_realloc(c->stream, capacity);
        if (!grown) {
            return;
        }
        c->stream = grown;
        c->capacity = capacity;
    }
    const uint32_t header = (op << 16) | count;
    memcpy(c->stream + c->used, &header, 4);
    if (count) {
        memcpy(c->stream + c->used + 4, words, (size_t)count * 4);
    }
    c->used += need;
    if (c->used >= FLUSH_AT) {
        flush_stream(c);
    }
}

#include "ecmaos_gl_cmds.inc"

static bool open_context(Context *c, int width, int height)
{
    uint32_t size[2] = { (uint32_t)width, (uint32_t)height };
    const int control = open("/dev/glctl", O_RDWR);
    if (control < 0) {
        return false;
    }
    const int made = ioctl(control, GLCTL_CREATE, size);
    close(control);
    if (made != 0) {
        return false;
    }
    char path[32];
    SDL_snprintf(path, sizeof path, "/dev/gl%u", (unsigned)size[0]);
    c->fd = open(path, O_RDWR);
    if (c->fd < 0) {
        return false;
    }
    c->width = width;
    c->height = height;
    return true;
}

static bool query_info(Context *c, uint32_t info[4])
{
    return flush_stream(c) && ioctl(c->fd, GL_GETINFO_REQUEST, info) == 0;
}

// - GLES2 calls that are answered here ----------------------------------------------------------------------

GL_APICALL GLenum GL_APIENTRY glGetError(void)
{
    uint32_t info[4] = { 0, 0, 0, 0 };
    if (!current || !query_info(current, info)) {
        return GL_NO_ERROR;
    }
    return (GLenum)info[3];
}

GL_APICALL void GL_APIENTRY glFlush(void)
{
    if (current) {
        flush_stream(current);
    }
}

GL_APICALL void GL_APIENTRY glFinish(void)
{
    glFlush();
}

GL_APICALL const GLubyte *GL_APIENTRY glGetString(GLenum name)
{
    switch (name) {
    case GL_VENDOR:
        return (const GLubyte *)"ecmaOS";
    case GL_RENDERER:
        return (const GLubyte *)"WebGL2 through /dev/gl";
    case GL_VERSION:
        return (const GLubyte *)"OpenGL ES 2.0 ecmaOS";
    case GL_SHADING_LANGUAGE_VERSION:
        return (const GLubyte *)"OpenGL ES GLSL ES 1.00";
    case GL_EXTENSIONS:
        return (const GLubyte *)"";
    default:
        return NULL;
    }
}

GL_APICALL void GL_APIENTRY glGetIntegerv(GLenum name, GLint *values)
{
    switch (name) {
    case GL_RED_BITS:
    case GL_GREEN_BITS:
    case GL_BLUE_BITS:
    case GL_ALPHA_BITS:
        values[0] = 8;
        break;
    case GL_DEPTH_BITS:
        values[0] = 24;
        break;
    case GL_STENCIL_BITS:
        values[0] = 8;
        break;
    case GL_MAX_TEXTURE_SIZE:
        values[0] = 4096;
        break;
    case GL_VIEWPORT: // what a new context has; the program's own glViewport is not tracked here
        values[0] = values[1] = 0;
        values[2] = current ? current->width : 0;
        values[3] = current ? current->height : 0;
        break;
    default:
        values[0] = 0;
        break;
    }
}

// - EGL ------------------------------------------------------------------------------------------------

EGLAPI EGLint EGLAPIENTRY eglGetError(void)
{
    const EGLint error = last_error;
    last_error = EGL_SUCCESS;
    return error;
}

EGLAPI EGLDisplay EGLAPIENTRY eglGetDisplay(EGLNativeDisplayType native)
{
    return native ? (EGLDisplay)native : ECMAOS_DISPLAY_FALLBACK;
}

EGLAPI EGLDisplay EGLAPIENTRY eglGetPlatformDisplay(EGLenum platform, void *native, const EGLAttrib *attribs)
{
    return native ? (EGLDisplay)native : ECMAOS_DISPLAY_FALLBACK;
}

EGLAPI EGLBoolean EGLAPIENTRY eglInitialize(EGLDisplay display, EGLint *major, EGLint *minor)
{
    if (major) {
        *major = 1;
    }
    if (minor) {
        *minor = 4;
    }
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglTerminate(EGLDisplay display)
{
    return EGL_TRUE;
}

EGLAPI const char *EGLAPIENTRY eglQueryString(EGLDisplay display, EGLint name)
{
    switch (name) {
    case EGL_VENDOR:
        return "ecmaOS";
    case EGL_VERSION:
        return "1.4 ecmaOS";
    case EGL_CLIENT_APIS:
        return "OpenGL_ES";
    case EGL_EXTENSIONS:
        return "";
    default:
        last_error = EGL_BAD_PARAMETER;
        return NULL;
    }
}

EGLAPI EGLBoolean EGLAPIENTRY eglBindAPI(EGLenum api)
{
    return api == EGL_OPENGL_ES_API ? EGL_TRUE : fail(EGL_BAD_PARAMETER);
}

// the one configuration there is: 8 bits a channel, 24 of depth and 8 of stencil, no multisampling
static bool config_value(EGLint attribute, EGLint *value)
{
    switch (attribute) {
    case EGL_BUFFER_SIZE: *value = 32; break;
    case EGL_RED_SIZE: case EGL_GREEN_SIZE: case EGL_BLUE_SIZE: case EGL_ALPHA_SIZE: *value = 8; break;
    case EGL_DEPTH_SIZE: *value = 24; break;
    case EGL_STENCIL_SIZE: *value = 8; break;
    case EGL_SAMPLES: case EGL_SAMPLE_BUFFERS: case EGL_LEVEL: case EGL_LUMINANCE_SIZE: case EGL_ALPHA_MASK_SIZE: *value = 0; break;
    case EGL_SURFACE_TYPE: *value = EGL_WINDOW_BIT; break;
    case EGL_RENDERABLE_TYPE: case EGL_CONFORMANT: *value = EGL_OPENGL_ES2_BIT; break;
    case EGL_CONFIG_ID: *value = 1; break;
    case EGL_NATIVE_RENDERABLE: *value = EGL_TRUE; break;
    case EGL_NATIVE_VISUAL_ID: case EGL_NATIVE_VISUAL_TYPE: *value = 0; break;
    case EGL_CONFIG_CAVEAT: case EGL_TRANSPARENT_TYPE: *value = EGL_NONE; break;
    case EGL_COLOR_BUFFER_TYPE: *value = EGL_RGB_BUFFER; break;
    case EGL_BIND_TO_TEXTURE_RGB: case EGL_BIND_TO_TEXTURE_RGBA: *value = EGL_FALSE; break;
    case EGL_MAX_PBUFFER_WIDTH: case EGL_MAX_PBUFFER_HEIGHT: *value = 4096; break;
    case EGL_MAX_PBUFFER_PIXELS: *value = 4096 * 4096; break;
    case EGL_MAX_SWAP_INTERVAL: *value = 1; break;
    case EGL_MIN_SWAP_INTERVAL: *value = 0; break;
    default: return false;
    }
    return true;
}

EGLAPI EGLBoolean EGLAPIENTRY eglGetConfigAttrib(EGLDisplay display, EGLConfig config, EGLint attribute, EGLint *value)
{
    return config_value(attribute, value) ? EGL_TRUE : fail(EGL_BAD_ATTRIBUTE);
}

EGLAPI EGLBoolean EGLAPIENTRY eglChooseConfig(EGLDisplay display, const EGLint *attribs, EGLConfig *configs, EGLint size, EGLint *count)
{
    bool match = true;
    for (; attribs && *attribs != EGL_NONE; attribs += 2) {
        EGLint have;
        const EGLint want = attribs[1];
        if (want == EGL_DONT_CARE || !config_value(attribs[0], &have)) {
            continue;
        }
        switch (attribs[0]) {
        case EGL_RED_SIZE: case EGL_GREEN_SIZE: case EGL_BLUE_SIZE: case EGL_ALPHA_SIZE: case EGL_BUFFER_SIZE:
        case EGL_DEPTH_SIZE: case EGL_STENCIL_SIZE:
            match = match && want <= have;
            break;
        case EGL_SAMPLES: case EGL_SAMPLE_BUFFERS:
            match = match && want == 0;
            break;
        case EGL_SURFACE_TYPE:
            match = match && (want & ~(EGL_WINDOW_BIT | EGL_PBUFFER_BIT)) == 0 && (want & EGL_WINDOW_BIT || !want);
            break;
        case EGL_RENDERABLE_TYPE: case EGL_CONFORMANT:
            match = match && (want & ~(EGL_OPENGL_ES2_BIT | EGL_OPENGL_ES3_BIT)) == 0;
            break;
        default:
            break;
        }
    }
    if (count) {
        *count = match ? 1 : 0;
    }
    if (match && configs && size > 0) {
        configs[0] = ECMAOS_CONFIG;
    }
    return EGL_TRUE;
}

EGLAPI EGLContext EGLAPIENTRY eglCreateContext(EGLDisplay display, EGLConfig config, EGLContext share, const EGLint *attribs)
{
    EGLint version = 1;
    for (; attribs && *attribs != EGL_NONE; attribs += 2) {
        if (attribs[0] == EGL_CONTEXT_CLIENT_VERSION) {
            version = attribs[1];
        }
    }
    if (version < 2) {
        fail(EGL_BAD_CONFIG);
        return EGL_NO_CONTEXT;
    }
    Context *c = (Context *)SDL_calloc(1, sizeof(*c));
    if (!c) {
        fail(EGL_BAD_ALLOC);
        return EGL_NO_CONTEXT;
    }
    c->fd = -1;
    return (EGLContext)c;
}

EGLAPI EGLBoolean EGLAPIENTRY eglDestroyContext(EGLDisplay display, EGLContext context)
{
    Context *c = (Context *)context;
    if (!c) {
        return fail(EGL_BAD_CONTEXT);
    }
    if (current == c) {
        current = NULL;
    }
    if (c->fd >= 0) {
        ioctl(c->fd, GL_DESTROY_REQUEST, NULL);
        close(c->fd);
    }
    SDL_free(c->stream);
    SDL_free(c);
    return EGL_TRUE;
}

EGLAPI EGLSurface EGLAPIENTRY eglCreateWindowSurface(EGLDisplay display, EGLConfig config, EGLNativeWindowType window, const EGLint *attribs)
{
    struct wl_egl_window *win = (struct wl_egl_window *)window;
    Surface *s = win ? (Surface *)SDL_calloc(1, sizeof(*s)) : NULL;
    if (!s) {
        fail(win ? EGL_BAD_ALLOC : EGL_BAD_NATIVE_WINDOW);
        return EGL_NO_SURFACE;
    }
    s->window = win;
    s->width = win->width;
    s->height = win->height;
    return (EGLSurface)s;
}

EGLAPI EGLSurface EGLAPIENTRY eglCreatePbufferSurface(EGLDisplay display, EGLConfig config, const EGLint *attribs)
{
    fail(EGL_BAD_ALLOC);
    return EGL_NO_SURFACE;
}

static void release_slots(Surface *s)
{
    for (int i = 0; i < 2; i++) {
        if (s->slots[i].buffer) {
            wl_buffer_destroy(s->slots[i].buffer);
        }
        SDL_zero(s->slots[i]);
    }
    if (s->pool) {
        wl_shm_pool_destroy(s->pool);
        s->pool = NULL;
    }
    if (s->memory) {
        munmap(s->memory, s->memory_size);
        s->memory = NULL;
    }
}

EGLAPI EGLBoolean EGLAPIENTRY eglDestroySurface(EGLDisplay display, EGLSurface surface)
{
    Surface *s = (Surface *)surface;
    if (!s) {
        return fail(EGL_BAD_SURFACE);
    }
    release_slots(s);
    SDL_free(s);
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglMakeCurrent(EGLDisplay display, EGLSurface draw, EGLSurface read, EGLContext context)
{
    Context *c = (Context *)context;
    Surface *s = (Surface *)draw;
    if (current) {
        flush_stream(current);
    }
    if (!c) {
        current = NULL;
        return EGL_TRUE;
    }
    if (c->fd < 0 && !open_context(c, s ? s->window->width : 1, s ? s->window->height : 1)) {
        return fail(EGL_BAD_ALLOC);
    }
    current = c;
    return EGL_TRUE;
}

static void buffer_released(void *data, struct wl_buffer *buffer)
{
    ((Slot *)data)->busy = false;
}

static const struct wl_buffer_listener buffer_listener = { buffer_released };

static bool make_slots(Surface *s, SDL_VideoData *video)
{
    const size_t pitch = (size_t)s->width * 4;
    const size_t one = pitch * s->height;
    release_slots(s);
    s->memory_size = one * 2;
    const int fd = Wayland_CreateTempFD((off_t)s->memory_size);
    if (fd < 0) {
        return false;
    }
    s->memory = mmap(NULL, s->memory_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (s->memory == MAP_FAILED) {
        s->memory = NULL;
        close(fd);
        return false;
    }
    s->pool = wl_shm_create_pool(video->shm, fd, (int32_t)s->memory_size);
    close(fd);
    for (int i = 0; i < 2; i++) {
        Slot *slot = &s->slots[i];
        slot->pixels = (Uint8 *)s->memory + i * one;
        slot->buffer = wl_shm_pool_create_buffer(s->pool, (int32_t)(i * one), s->width, s->height, (int32_t)pitch, WL_SHM_FORMAT_XRGB8888);
        wl_buffer_add_listener(slot->buffer, &buffer_listener, slot);
    }
    s->next = 0;
    return true;
}

EGLAPI EGLBoolean EGLAPIENTRY eglSwapBuffers(EGLDisplay display, EGLSurface surface)
{
    Surface *s = (Surface *)surface;
    Context *c = current;
    SDL_VideoDevice *device = SDL_GetVideoDevice();
    SDL_VideoData *video = device ? device->internal : NULL;

    if (!s || !video || !video->shm) {
        return fail(EGL_BAD_SURFACE);
    }
    if (!c) {
        return fail(EGL_BAD_CONTEXT);
    }
    // the window has been resized: a new size for the context and for the buffers
    const int width = s->window->width, height = s->window->height;
    if (width < 1 || height < 1) {
        return EGL_TRUE;
    }
    if (!flush_stream(c)) {
        return fail(EGL_CONTEXT_LOST);
    }
    if (width != c->width || height != c->height) {
        uint32_t size[2] = { (uint32_t)width, (uint32_t)height };
        if (ioctl(c->fd, GL_RESIZE_REQUEST, size) != 0) {
            return fail(EGL_BAD_ALLOC);
        }
        c->width = width;
        c->height = height;
    }
    if (!s->pool || width != s->width || height != s->height) {
        s->width = width;
        s->height = height;
        if (!make_slots(s, video)) {
            return fail(EGL_BAD_ALLOC);
        }
    }

    uint32_t frames = 0;
    if (ioctl(c->fd, GL_SWAP_REQUEST, &frames) != 0) {
        return fail(EGL_CONTEXT_LOST);
    }

    // a buffer the compositor has let go of
    Slot *slot = &s->slots[s->next];
    if (slot->busy) {
        for (int tries = 0; tries < 8 && slot->busy; tries++) {
            wl_display_roundtrip(video->display);
        }
        if (slot->busy && !s->slots[s->next ^ 1].busy) {
            slot = &s->slots[s->next ^ 1];
        }
    }
    s->next = (int)(slot - s->slots) ^ 1;

    const size_t total = (size_t)width * height * 4;
    size_t done = 0;
    while (done < total) {
        const ssize_t n = read(c->fd, (Uint8 *)slot->pixels + done, total - done);
        if (n <= 0) {
            return fail(EGL_CONTEXT_LOST);
        }
        done += (size_t)n;
    }

    struct wl_surface *surface_proxy = s->window->surface;
    wl_surface_attach(surface_proxy, slot->buffer, 0, 0);
    slot->busy = true;
    if (wl_compositor_get_version(video->compositor) >= WL_SURFACE_DAMAGE_BUFFER_SINCE_VERSION) {
        wl_surface_damage_buffer(surface_proxy, 0, 0, SDL_MAX_SINT32, SDL_MAX_SINT32);
    } else {
        wl_surface_damage(surface_proxy, 0, 0, SDL_MAX_SINT32, SDL_MAX_SINT32);
    }
    wl_surface_commit(surface_proxy);
    wl_display_flush(video->display);
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglSwapInterval(EGLDisplay display, EGLint interval)
{
    return EGL_TRUE; // SDL paces the frames itself on the compositor's frame callbacks
}

EGLAPI EGLBoolean EGLAPIENTRY eglWaitNative(EGLint engine)
{
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglWaitGL(void)
{
    return EGL_TRUE;
}

EGLAPI __eglMustCastToProperFunctionPointerType EGLAPIENTRY eglGetProcAddress(const char *name)
{
    static const struct { const char *name; void *function; } own[] = {
        { "glGetError", (void *)glGetError },
        { "glFlush", (void *)glFlush },
        { "glFinish", (void *)glFinish },
        { "glGetString", (void *)glGetString },
        { "glGetIntegerv", (void *)glGetIntegerv },
        { "eglGetPlatformDisplay", (void *)eglGetPlatformDisplay },
        { NULL, NULL }
    };
    if (!name) {
        return NULL;
    }
    for (int i = 0; own[i].name; i++) {
        if (SDL_strcmp(own[i].name, name) == 0) {
            return (__eglMustCastToProperFunctionPointerType)own[i].function;
        }
    }
    for (int i = 0; ecmaos_gl_commands[i].name; i++) {
        if (SDL_strcmp(ecmaos_gl_commands[i].name, name) == 0) {
            return (__eglMustCastToProperFunctionPointerType)ecmaos_gl_commands[i].function;
        }
    }
    return NULL;
}

#endif // SDL_VIDEO_DRIVER_WAYLAND && SDL_VIDEO_OPENGL_EGL
