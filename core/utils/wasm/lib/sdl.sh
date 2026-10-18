#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of programs that use SDL: builds SDL 3.4.18 (zlib license) as a static library into
# "$1/prefix", with its Wayland video driver (build_wayland and build_xkbcommon must have run for the same "$1": the
# driver wants libwayland-client, -cursor, -egl and libxkbcommon, found through the pkg-config files they leave).
# Sets SDL_INC and SDL_LIB for the caller; link with $SDL_LIB $SDL_DEPS_LIB.
#
# SDL treats Emscripten as the browser canvas (its own video, audio and timer code that calls into JavaScript). Here
# the target is a Unix program on a Wayland compositor, so these changes are made to the source:
#   - SDL_PLATFORM_EMSCRIPTEN is not defined, and CMake takes the Unix branch (no calls into the page);
#   - the Wayland driver gets a software window surface, which SDL's own driver lacks (it presents only through
#     OpenGL, Vulkan or a hardware render driver): SDL_GetWindowSurface and the software renderer draw into memory,
#     and SDL_UpdateWindowSurface copies it into a wl_shm buffer and commits it;
#   - the failed start of the cursor animation thread (SDL is built without threads) is logged at debug level;
#   - audio is a driver of its own (src/audio/ecmaos): it writes interleaved signed 16 bit stereo at 48000 Hz to
#     /dev/dsp1 and SDL converts whatever the program asks for. SDL is built without threads, so the driver has no
#     callback thread: SDL_PumpEvents (so SDL_PollEvent and SDL_WaitEvent) keeps the device about 100 ms ahead of
#     the clock, and a program that does not poll events for a while is silent for that while;
#   - the clipboard tells its own offers from other programs' by process id, which is 42 for every Emscripten program;
#     the id gets the clock mixed in;
#   - joysticks are a driver of their own (src/joystick/ecmaos): it reads the pads the browser has from /dev/js0 to
#     /dev/js3 (Linux's joystick API). A pad shows up once a button has been pressed on it; the browser's "standard"
#     pads get the SDL gamepad mapping, with the triggers as buttons;
#   - OpenGL ES is an EGL and GLES2 of our own (sdl-gl/): calls are packed into a command stream that the kernel runs on
#     the browser's WebGL2 (/dev/gl<N>), and each frame comes back as pixels in a wl_shm buffer (see ecmaos_gl.c);
#   - nothing else: no desktop OpenGL, no libdecor.
set -euo pipefail

SDL_GL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sdl-gl
SDL=3.4.18
SDL_SHA256=9c75cf16330322c217dedd2e0609f1124f1b54b8633e763467b4684d0f4334a3

build_sdl() {
  local work=$1
  command -v cmake > /dev/null || { echo "sdl: needs the host cmake" >&2; exit 1; }
  command -v ninja > /dev/null || { echo "sdl: needs the host ninja" >&2; exit 1; }
  command -v pkg-config > /dev/null || { echo "sdl: needs the host pkg-config" >&2; exit 1; }
  ( cd "$work"
    if [ -n "${SDL_ARCHIVE:-}" ]; then cp "$SDL_ARCHIVE" sdl.tar.gz   # an archive already fetched (a copyleft build's sources/)
    else curl -fsSL -o sdl.tar.gz "https://github.com/libsdl-org/SDL/releases/download/release-$SDL/SDL3-$SDL.tar.gz"; fi
    echo "$SDL_SHA256  sdl.tar.gz" | sha256sum -c -
    tar xzf sdl.tar.gz
    cd "SDL3-$SDL"

    sed -i 's/^#ifdef __EMSCRIPTEN__$/#if 0 \/* ecmaOS: a Unix program, not the browser canvas *\//' include/SDL3/SDL_platform_defines.h
    sed -i 's/^elseif(EMSCRIPTEN)$/elseif(EMSCRIPTEN AND NOT SDL_ECMAOS)/' CMakeLists.txt
    sed -i 's/SDL_LogError(SDL_LOG_CATEGORY_VIDEO, "wayland: Failed to start cursor animation event thread")/SDL_LogDebug(SDL_LOG_CATEGORY_VIDEO, "wayland: no cursor animation thread (SDL is built without threads)")/' src/video/wayland/SDL_waylandmouse.c
    sed -i 's/^static int CreateTempFD(off_t size)/int Wayland_CreateTempFD(off_t size)/; s/= CreateTempFD(/= Wayland_CreateTempFD(/' src/video/wayland/SDL_waylandshmbuffer.c
    sed -i 's/^    device->SuspendScreenSaver = Wayland_SuspendScreenSaver;$/&\n    device->CreateWindowFramebuffer = Wayland_CreateWindowFramebuffer;\n    device->UpdateWindowFramebuffer = Wayland_UpdateWindowFramebuffer;\n    device->DestroyWindowFramebuffer = Wayland_DestroyWindowFramebuffer;/' src/video/wayland/SDL_waylandvideo.c
    sed -i '0,/^#include "SDL_waylandvideo.h"$/s//&\n#include "SDL_waylandframebuffer.h"/' src/video/wayland/SDL_waylandvideo.c
    grep -q SDL_waylandframebuffer.h src/video/wayland/SDL_waylandvideo.c && grep -q Wayland_CreateWindowFramebuffer src/video/wayland/SDL_waylandvideo.c || { echo "sdl: the video device patch did not apply" >&2; exit 1; }
    grep -q "SDL_ECMAOS" CMakeLists.txt || { echo "sdl: the CMake patch did not apply" >&2; exit 1; }
    sed -i 's/^  if(SDL_DUMMYAUDIO)$/  if(SDL_ECMAOS)\n    set(SDL_AUDIO_DRIVER_ECMAOS 1)\n    sdl_glob_sources(\n      "${SDL3_SOURCE_DIR}\/src\/audio\/ecmaos\/*.c"\n      "${SDL3_SOURCE_DIR}\/src\/audio\/ecmaos\/*.h"\n    )\n    set(HAVE_SDL_AUDIO TRUE)\n  endif()\n&/' CMakeLists.txt
    sed -i 's/^#ifdef SDL_AUDIO_DRIVER_DISK$/#ifdef SDL_AUDIO_DRIVER_ECMAOS\n    \&ECMAOSAUDIO_bootstrap,\n#endif\n&/' src/audio/SDL_audio.c
    sed -i 's/^extern AudioBootStrap DUMMYAUDIO_bootstrap;$/&\nextern AudioBootStrap ECMAOSAUDIO_bootstrap;/' src/audio/SDL_sysaudio.h
    sed -i 's/^static void SDL_PumpEventsInternal(bool push_sentinel)$/extern void ECMAOS_PumpAudio(void);\n&/; s/^    \/\/ Free any temporary memory from old events$/    ECMAOS_PumpAudio();\n&/' src/events/SDL_events.c
    grep -q ECMAOSAUDIO_bootstrap src/audio/SDL_audio.c && grep -q ECMAOSAUDIO_bootstrap src/audio/SDL_sysaudio.h && grep -q ECMAOS_PumpAudio src/events/SDL_events.c && grep -q SDL_AUDIO_DRIVER_ECMAOS CMakeLists.txt || { echo "sdl: the audio patch did not apply" >&2; exit 1; }
    sed -i 's/^        Uint64 pid = (Uint64)getpid();$/        Uint64 pid = (Uint64)getpid() ^ (SDL_GetPerformanceCounter() << 8);   \/\* ecmaOS: getpid() is 42 in every program \*\//' src/video/wayland/SDL_waylandevents.c
    grep -q "getpid() is 42" src/video/wayland/SDL_waylandevents.c || { echo "sdl: the clipboard id patch did not apply" >&2; exit 1; }
    sed -i 's/^if(NOT HAVE_SDL_JOYSTICK)$/if(SDL_ECMAOS AND SDL_JOYSTICK)\n  set(SDL_JOYSTICK_ECMAOS 1)\n  sdl_glob_sources(\n    "${SDL3_SOURCE_DIR}\/src\/joystick\/ecmaos\/*.c"\n  )\n  set(HAVE_SDL_JOYSTICK TRUE)\nendif()\n&/' CMakeLists.txt
    sed -i 's/^#ifdef SDL_JOYSTICK_EMSCRIPTEN$/#ifdef SDL_JOYSTICK_ECMAOS\n    \&SDL_ECMAOS_JoystickDriver,\n#endif\n&/' src/joystick/SDL_joystick.c
    sed -i 's/^extern SDL_JoystickDriver SDL_ANDROID_JoystickDriver;$/&\nextern SDL_JoystickDriver SDL_ECMAOS_JoystickDriver;/' src/joystick/SDL_sysjoystick.h
    grep -q SDL_JOYSTICK_ECMAOS CMakeLists.txt && grep -q SDL_ECMAOS_JoystickDriver src/joystick/SDL_joystick.c && grep -q SDL_ECMAOS_JoystickDriver src/joystick/SDL_sysjoystick.h || { echo "sdl: the joystick patch did not apply" >&2; exit 1; }
    mkdir -p src/audio/ecmaos
    cat > src/audio/ecmaos/SDL_ecmaosaudio.c <<'SOURCE'
// Audio for ecmaOS (added for it): playback to /dev/dsp1, interleaved signed 16 bit stereo at 48000 Hz, which the
// kernel plays through the browser. There is no callback thread (SDL is built without threads): SDL_PumpEvents calls
// ECMAOS_PumpAudio, which runs the device's iteration (SDL_PlaybackAudioThreadIterate: it fills a buffer from the bound
// streams, calling their callbacks) until about 100 ms of sound is queued ahead of the clock.
#include "SDL_internal.h"

#ifdef SDL_AUDIO_DRIVER_ECMAOS

#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

#include "../SDL_sysaudio.h"

#define ECMAOS_AUDIO_NODE "/dev/dsp1"
#define ECMAOS_AUDIO_RATE 48000
#define ECMAOS_AUDIO_CHANNELS 2
#define ECMAOS_AUDIO_AHEAD_NS (100 * SDL_NS_PER_MS)
#define ECMAOS_AUDIO_MAX 8

struct SDL_PrivateAudioData
{
    int fd;
    Uint8 *mixbuf;
    Uint64 queued_until; // when the sound written so far ends, in SDL_GetTicksNS time
    Uint64 period_ns;
};

static SDL_AudioDevice *ecmaos_devices[ECMAOS_AUDIO_MAX];

void ECMAOS_PumpAudio(void)
{
    for (int i = 0; i < ECMAOS_AUDIO_MAX; i++) {
        SDL_AudioDevice *device = ecmaos_devices[i];
        if (!device || !device->hidden) {
            continue;
        }
        struct SDL_PrivateAudioData *priv = device->hidden;
        const Uint64 now = SDL_GetTicksNS();
        if (priv->queued_until < now) {
            priv->queued_until = now; // the program stalled: do not make up the time with a burst
        }
        while (priv->queued_until - now < ECMAOS_AUDIO_AHEAD_NS) {
            if (!SDL_PlaybackAudioThreadIterate(device)) {
                break;
            }
            if (!ecmaos_devices[i] || !device->hidden) {
                break; // the device was lost during the iteration
            }
            priv->queued_until += priv->period_ns;
        }
    }
}

static bool ECMAOSAUDIO_OpenDevice(SDL_AudioDevice *device)
{
    if (device->recording) {
        return SDL_SetError("ecmaos audio: recording is not supported");
    }
    int slot = -1;
    for (int i = 0; i < ECMAOS_AUDIO_MAX; i++) {
        if (!ecmaos_devices[i]) {
            slot = i;
            break;
        }
    }
    if (slot < 0) {
        return SDL_SetError("ecmaos audio: too many open devices");
    }

    device->hidden = (struct SDL_PrivateAudioData *)SDL_calloc(1, sizeof(*device->hidden));
    if (!device->hidden) {
        return false;
    }
    device->hidden->fd = open(ECMAOS_AUDIO_NODE, O_WRONLY | O_NONBLOCK);
    if (device->hidden->fd < 0) {
        const int err = errno;
        SDL_free(device->hidden);
        device->hidden = NULL;
        return SDL_SetError("ecmaos audio: cannot open %s (errno %d)", ECMAOS_AUDIO_NODE, err);
    }

    device->spec.format = SDL_AUDIO_S16LE;
    device->spec.channels = ECMAOS_AUDIO_CHANNELS;
    device->spec.freq = ECMAOS_AUDIO_RATE;
    SDL_UpdatedAudioDeviceFormat(device);

    device->hidden->mixbuf = (Uint8 *)SDL_malloc(device->buffer_size);
    if (!device->hidden->mixbuf) {
        close(device->hidden->fd);
        SDL_free(device->hidden);
        device->hidden = NULL;
        return false;
    }
    SDL_memset(device->hidden->mixbuf, device->silence_value, device->buffer_size);
    device->hidden->period_ns = ((Uint64)device->sample_frames * SDL_NS_PER_SECOND) / device->spec.freq;
    device->hidden->queued_until = SDL_GetTicksNS();
    ecmaos_devices[slot] = device;
    return true;
}

static void ECMAOSAUDIO_CloseDevice(SDL_AudioDevice *device)
{
    for (int i = 0; i < ECMAOS_AUDIO_MAX; i++) {
        if (ecmaos_devices[i] == device) {
            ecmaos_devices[i] = NULL;
        }
    }
    if (device->hidden) {
        close(device->hidden->fd);
        SDL_free(device->hidden->mixbuf);
        SDL_free(device->hidden);
        device->hidden = NULL;
    }
}

static Uint8 *ECMAOSAUDIO_GetDeviceBuf(SDL_AudioDevice *device, int *buffer_size)
{
    return device->hidden->mixbuf;
}

static bool ECMAOSAUDIO_PlayDevice(SDL_AudioDevice *device, const Uint8 *buffer, int buflen)
{
    int done = 0;
    while (done < buflen) {
        const ssize_t n = write(device->hidden->fd, buffer + done, buflen - done);
        if (n > 0) {
            done += (int)n;
        } else if (n < 0 && errno == EINTR) {
            continue;
        } else if (n < 0 && errno == EAGAIN) {
            break; // the kernel holds as much as it takes: this part of the sound is dropped
        } else {
            return SDL_SetError("ecmaos audio: write to %s failed (errno %d)", ECMAOS_AUDIO_NODE, errno);
        }
    }
    return true;
}

static bool ECMAOSAUDIO_Init(SDL_AudioDriverImpl *impl)
{
    if (access(ECMAOS_AUDIO_NODE, W_OK) != 0) {
        return SDL_SetError("ecmaos audio: %s is not there", ECMAOS_AUDIO_NODE);
    }
    impl->OpenDevice = ECMAOSAUDIO_OpenDevice;
    impl->CloseDevice = ECMAOSAUDIO_CloseDevice;
    impl->GetDeviceBuf = ECMAOSAUDIO_GetDeviceBuf;
    impl->PlayDevice = ECMAOSAUDIO_PlayDevice;
    impl->ProvidesOwnCallbackThread = true;
    impl->OnlyHasDefaultPlaybackDevice = true;
    return true;
}

AudioBootStrap ECMAOSAUDIO_bootstrap = {
    "ecmaos", "ecmaOS audio driver", ECMAOSAUDIO_Init, false, false
};

#endif // SDL_AUDIO_DRIVER_ECMAOS
SOURCE

    cat > src/video/wayland/SDL_waylandframebuffer.h <<'HEADER'
#ifndef SDL_waylandframebuffer_h_
#define SDL_waylandframebuffer_h_

#include "../SDL_sysvideo.h"

extern bool Wayland_CreateWindowFramebuffer(SDL_VideoDevice *_this, SDL_Window *window, SDL_PixelFormat *format, void **pixels, int *pitch);
extern bool Wayland_UpdateWindowFramebuffer(SDL_VideoDevice *_this, SDL_Window *window, const SDL_Rect *rects, int numrects);
extern void Wayland_DestroyWindowFramebuffer(SDL_VideoDevice *_this, SDL_Window *window);

#endif
HEADER

    cat > src/video/wayland/SDL_waylandframebuffer.c <<'SOURCE'
// A software window surface for the Wayland driver (added for ecmaOS). SDL_GetWindowSurface hands out memory in the
// size of the window; SDL_UpdateWindowSurface copies it into one of two wl_shm buffers and commits that. The second
// buffer is for a compositor that has not released the first yet (ecmaOS's releases at the commit).
#include "SDL_internal.h"

#ifdef SDL_VIDEO_DRIVER_WAYLAND

#include <sys/mman.h>
#include <unistd.h>

#include "../SDL_sysvideo.h"
#include "SDL_waylandvideo.h"
#include "SDL_waylandwindow.h"
#include "SDL_waylandframebuffer.h"

extern int Wayland_CreateTempFD(off_t size);

#define WAYLAND_FRAMEBUFFER_PROPERTY "SDL.internal.window.waylandframebuffer"

typedef struct FramebufferData FramebufferData;

typedef struct
{
    FramebufferData *owner;
    struct wl_buffer *buffer;
    void *pixels;
    bool busy;
} FramebufferBuffer;

struct FramebufferData
{
    struct wl_shm_pool *pool;
    void *memory;
    size_t memory_size;
    void *backing;
    int width, height, pitch;
    int next;
    FramebufferBuffer buffers[2];
};

static void framebuffer_buffer_release(void *data, struct wl_buffer *wl_buffer)
{
    ((FramebufferBuffer *)data)->busy = false;
}

static const struct wl_buffer_listener framebuffer_buffer_listener = {
    framebuffer_buffer_release
};

static void FreeFramebuffer(void *value)
{
    FramebufferData *fb = (FramebufferData *)value;
    if (!fb) {
        return;
    }
    for (int i = 0; i < 2; i++) {
        if (fb->buffers[i].buffer) {
            wl_buffer_destroy(fb->buffers[i].buffer);
        }
    }
    if (fb->pool) {
        wl_shm_pool_destroy(fb->pool);
    }
    if (fb->memory) {
        munmap(fb->memory, fb->memory_size);
    }
    SDL_aligned_free(fb->backing);
    SDL_free(fb);
}

static void FreeFramebufferProperty(void *userdata, void *value)
{
    FreeFramebuffer(value);
}

bool Wayland_CreateWindowFramebuffer(SDL_VideoDevice *_this, SDL_Window *window, SDL_PixelFormat *format, void **pixels, int *pitch)
{
    SDL_VideoData *viddata = _this->internal;
    const bool transparent = (window->flags & SDL_WINDOW_TRANSPARENT) ? true : false;
    int w, h;

    if (!viddata->shm) {
        return SDL_SetError("The compositor offers no wl_shm");
    }

    Wayland_DestroyWindowFramebuffer(_this, window);

    SDL_GetWindowSizeInPixels(window, &w, &h);
    if (w <= 0 || h <= 0) {
        return SDL_SetError("The window has no size yet");
    }

    FramebufferData *fb = (FramebufferData *)SDL_calloc(1, sizeof(*fb));
    if (!fb) {
        return false;
    }
    fb->width = w;
    fb->height = h;
    fb->pitch = w * 4;

    const size_t one = (size_t)fb->pitch * h;
    fb->memory_size = one * 2;
    fb->backing = SDL_aligned_alloc(SDL_GetSIMDAlignment(), one);
    const int fd = Wayland_CreateTempFD((off_t)fb->memory_size);
    if (!fb->backing || fd < 0) {
        if (fd >= 0) {
            close(fd);
        }
        FreeFramebuffer(fb);
        return SDL_SetError("Creating the window surface failed");
    }
    SDL_memset(fb->backing, 0, one);

    fb->memory = mmap(NULL, fb->memory_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (fb->memory == MAP_FAILED) {
        fb->memory = NULL;
        close(fd);
        FreeFramebuffer(fb);
        return SDL_SetError("mmap() failed");
    }
    fb->pool = wl_shm_create_pool(viddata->shm, fd, (int32_t)fb->memory_size);
    close(fd);

    const uint32_t wl_format = transparent ? WL_SHM_FORMAT_ARGB8888 : WL_SHM_FORMAT_XRGB8888;
    for (int i = 0; i < 2; i++) {
        FramebufferBuffer *b = &fb->buffers[i];
        b->owner = fb;
        b->pixels = (Uint8 *)fb->memory + i * one;
        b->buffer = wl_shm_pool_create_buffer(fb->pool, (int32_t)(i * one), w, h, fb->pitch, wl_format);
        wl_buffer_add_listener(b->buffer, &framebuffer_buffer_listener, b);
    }

    SDL_SetPointerPropertyWithCleanup(SDL_GetWindowProperties(window), WAYLAND_FRAMEBUFFER_PROPERTY, fb, FreeFramebufferProperty, NULL);

    *format = transparent ? SDL_PIXELFORMAT_ARGB8888 : SDL_PIXELFORMAT_XRGB8888;
    *pixels = fb->backing;
    *pitch = fb->pitch;
    return true;
}

bool Wayland_UpdateWindowFramebuffer(SDL_VideoDevice *_this, SDL_Window *window, const SDL_Rect *rects, int numrects)
{
    SDL_VideoData *viddata = _this->internal;
    SDL_WindowData *wind = window->internal;
    FramebufferData *fb = (FramebufferData *)SDL_GetPointerProperty(SDL_GetWindowProperties(window), WAYLAND_FRAMEBUFFER_PROPERTY, NULL);

    if (!fb) {
        return SDL_SetError("Couldn't find the window surface");
    }
    // Before the compositor has configured the window a buffer may not be attached.
    if (wind->shell_surface_status != WAYLAND_SHELL_SURFACE_STATUS_SHOWN && wind->shell_surface_status != WAYLAND_SHELL_SURFACE_STATUS_WAITING_FOR_FRAME) {
        return true;
    }

    FramebufferBuffer *b = &fb->buffers[fb->next];
    if (b->busy) {
        FramebufferBuffer *other = &fb->buffers[fb->next ^ 1];
        if (other->busy) {
            // The compositor holds both; its releases are in the queue.
            for (int tries = 0; tries < 8 && b->busy && other->busy; tries++) {
                wl_display_roundtrip(viddata->display);
            }
        }
        if (b->busy && !other->busy) {
            b = other;
        }
    }
    fb->next = (int)(b - fb->buffers) ^ 1;

    SDL_memcpy(b->pixels, fb->backing, (size_t)fb->pitch * fb->height);

    wl_surface_attach(wind->surface, b->buffer, 0, 0);
    b->busy = true;
    if (numrects > 0 && wl_compositor_get_version(viddata->compositor) >= WL_SURFACE_DAMAGE_BUFFER_SINCE_VERSION) {
        for (int i = 0; i < numrects; i++) {
            wl_surface_damage_buffer(wind->surface, rects[i].x, rects[i].y, rects[i].w, rects[i].h);
        }
    } else if (wl_compositor_get_version(viddata->compositor) >= WL_SURFACE_DAMAGE_BUFFER_SINCE_VERSION) {
        wl_surface_damage_buffer(wind->surface, 0, 0, SDL_MAX_SINT32, SDL_MAX_SINT32);
    } else {
        wl_surface_damage(wind->surface, 0, 0, SDL_MAX_SINT32, SDL_MAX_SINT32);
    }
    wl_surface_commit(wind->surface);
    wl_display_flush(viddata->display);
    return true;
}

void Wayland_DestroyWindowFramebuffer(SDL_VideoDevice *_this, SDL_Window *window)
{
    SDL_ClearProperty(SDL_GetWindowProperties(window), WAYLAND_FRAMEBUFFER_PROPERTY);
}

#endif // SDL_VIDEO_DRIVER_WAYLAND
SOURCE
    # OpenGL ES: an EGL and a GLES2 of our own (sdl-gl/), linked in place of a GPU driver. SDL_VIDEO_STATIC_ANGLE makes SDL
    # call the eglXxx functions directly instead of loading libEGL.
    mkdir -p src/video/ecmaos
    cp "$SDL_GL_DIR/ecmaos_gl.c" src/video/ecmaos/
    node "$SDL_GL_DIR/gen-cmds.mjs" "$SDL_GL_DIR/../../../../kernel/src/tree/lib/gl-commands.json" > src/video/ecmaos/ecmaos_gl_cmds.inc
    sed -i 's/^if(NOT HAVE_SDL_JOYSTICK)$/if(SDL_ECMAOS AND SDL_VIDEO_OPENGL_EGL)\n  sdl_glob_sources("${SDL3_SOURCE_DIR}\/src\/video\/ecmaos\/*.c")\nendif()\n&/' CMakeLists.txt
    grep -q "src/video/ecmaos" CMakeLists.txt || { echo "sdl: the OpenGL ES patch did not apply" >&2; exit 1; }
    mkdir -p src/joystick/ecmaos
    cat > src/joystick/ecmaos/SDL_sysjoystick.c <<'SOURCE'
// Joysticks for ecmaOS (added for it): the pads the browser has, as /dev/js0 to /dev/js3 in the layout of Linux's joystick
// API (struct js_event: u32 ms, s16 value, u8 type, u8 number; type 1 is a button, 2 an axis, and 0x80 is added to the
// state the pad was in when the node was opened). The browser shows a pad only once a button has been pressed on it,
// and the nodes exist ahead, so a node that fails to read is a slot with no pad: SDL_JoystickDetect (run from
// SDL_PumpEvents) looks at the empty slots about once a second. A pad that reads as the end of the file was unplugged.
// A pad the browser calls "standard" (17 buttons, 4 axes) gets the mapping of a game console pad, so the SDL gamepad API
// works on it; its triggers are buttons here (the node reports them as pressed or not), not analog axes.
#include "SDL_internal.h"

#ifdef SDL_JOYSTICK_ECMAOS

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <unistd.h>

#include "../SDL_sysjoystick.h"
#include "../SDL_joystick_c.h"

#define ECMAOS_PADS 4
#define ECMAOS_PAD_MAX 32
#define ECMAOS_PAD_PROBE_MS 1000
#define ECMAOS_PAD_WAIT_MS 400

#define JS_EVENT_BUTTON 0x01
#define JS_EVENT_AXIS 0x02
#define JS_EVENT_INIT 0x80

typedef struct ecmaos_pad
{
    int fd;               // the node, open while probing and while the pad is there
    bool present;
    bool gone;            // read as the end of the file: Detect takes it away
    bool fresh;           // opened by the program and not yet told what the pad is doing
    Uint64 probed;        // when the slot was last tried, in SDL_GetTicks time
    char name[32];
    SDL_GUID guid;
    SDL_JoystickID instance;
    SDL_Joystick *joystick;
    int nbuttons;
    int naxes;
    Uint8 button[ECMAOS_PAD_MAX];
    Sint16 axis[ECMAOS_PAD_MAX];
} ecmaos_pad;

static ecmaos_pad ecmaos_pads[ECMAOS_PADS];
static int ecmaos_count = 0;

// Reads what the node has: calls on_event for each js_event, returns false at the end of the file or on an error
static bool ECMAOS_ReadPad(ecmaos_pad *pad, bool (*on_event)(ecmaos_pad *, Uint8, Uint8, Sint16, Uint64), Uint64 ts)
{
    Uint8 buf[8 * 32];
    for (int rounds = 0; rounds < 16; rounds++) {
        struct pollfd pfd = { pad->fd, POLLIN, 0 };
        if (poll(&pfd, 1, 0) <= 0) {
            return true;
        }
        const ssize_t got = read(pad->fd, buf, sizeof(buf));
        if (got < 0) {
            return errno == EAGAIN;
        }
        if (got == 0) {
            return false;
        }
        for (ssize_t at = 0; at + 8 <= got; at += 8) {
            const Sint16 value = (Sint16)(buf[at + 4] | (buf[at + 5] << 8));
            if (!on_event(pad, buf[at + 6], buf[at + 7], value, ts)) {
                return true;
            }
        }
    }
    return true;
}

static bool ECMAOS_Probe(ecmaos_pad *pad, Uint8 type, Uint8 number, Sint16 value, Uint64 ts)
{
    if (number >= ECMAOS_PAD_MAX) {
        return true;
    }
    if ((type & JS_EVENT_BUTTON) && number + 1 > pad->nbuttons) {
        pad->nbuttons = number + 1;
    } else if ((type & JS_EVENT_AXIS) && number + 1 > pad->naxes) {
        pad->naxes = number + 1;
    }
    if (type & JS_EVENT_BUTTON) {
        pad->button[number] = value ? 1 : 0;
    } else if (type & JS_EVENT_AXIS) {
        pad->axis[number] = value;
    }
    return true;
}

// Keeps the picture of a pad that nobody has open
static bool ECMAOS_Track(ecmaos_pad *pad, Uint8 type, Uint8 number, Sint16 value, Uint64 ts)
{
    if (number >= ECMAOS_PAD_MAX) {
        return true;
    }
    if ((type & JS_EVENT_BUTTON) && number < pad->nbuttons) {
        pad->button[number] = value ? 1 : 0;
    } else if ((type & JS_EVENT_AXIS) && number < pad->naxes) {
        pad->axis[number] = value;
    }
    return true;
}

// Sends what happens on a pad the program has open
static bool ECMAOS_Send(ecmaos_pad *pad, Uint8 type, Uint8 number, Sint16 value, Uint64 ts)
{
    if (number >= ECMAOS_PAD_MAX || !pad->joystick) {
        return true;
    }
    if ((type & JS_EVENT_BUTTON) && number < pad->nbuttons) {
        const Uint8 down = value ? 1 : 0;
        if (pad->button[number] != down) {
            pad->button[number] = down;
            SDL_SendJoystickButton(ts, pad->joystick, number, down);
        }
    } else if ((type & JS_EVENT_AXIS) && number < pad->naxes) {
        if (pad->axis[number] != value) {
            pad->axis[number] = value;
            SDL_SendJoystickAxis(ts, pad->joystick, number, value);
        }
    }
    return true;
}

static void ECMAOS_ClosePad(ecmaos_pad *pad)
{
    if (pad->fd >= 0) {
        close(pad->fd);
    }
    pad->fd = -1;
}

static void ECMAOS_AddPad(int slot, ecmaos_pad *pad)
{
    SDL_snprintf(pad->name, sizeof(pad->name), "ecmaOS gamepad %d", slot);
    pad->guid = SDL_CreateJoystickGUIDForName("ecmaOS gamepad");
    pad->instance = SDL_GetNextObjectID();
    pad->present = true;
    pad->gone = false;
    ecmaos_count++;
    if (pad->nbuttons >= 16 && pad->naxes == 4) {
        char guid[33];
        char mapping[400];
        SDL_GUIDToString(pad->guid, guid, sizeof(guid));
        SDL_snprintf(mapping, sizeof(mapping),
                     "%s,ecmaOS gamepad,a:b0,b:b1,x:b2,y:b3,leftshoulder:b4,rightshoulder:b5,lefttrigger:b6,righttrigger:b7,"
                     "back:b8,start:b9,leftstick:b10,rightstick:b11,dpup:b12,dpdown:b13,dpleft:b14,dpright:b15%s,"
                     "leftx:a0,lefty:a1,rightx:a2,righty:a3,",
                     guid, pad->nbuttons >= 17 ? ",guide:b16" : "");
        SDL_AddGamepadMapping(mapping);
    }
    SDL_PrivateJoystickAdded(pad->instance);
}

static void ECMAOS_RemovePad(ecmaos_pad *pad)
{
    ECMAOS_ClosePad(pad);
    if (pad->joystick) {
        pad->joystick->hwdata = NULL;
    }
    const SDL_JoystickID instance = pad->instance;
    pad->present = false;
    pad->joystick = NULL;
    ecmaos_count--;
    SDL_PrivateJoystickRemoved(instance);
}

static bool ECMAOS_JoystickInit(void)
{
    SDL_zeroa(ecmaos_pads);
    for (int i = 0; i < ECMAOS_PADS; i++) {
        ecmaos_pads[i].fd = -1;
    }
    ecmaos_count = 0;
    return true;
}

static ecmaos_pad *ECMAOS_ByIndex(int device_index)
{
    for (int i = 0; i < ECMAOS_PADS; i++) {
        if (ecmaos_pads[i].present && device_index-- == 0) {
            return &ecmaos_pads[i];
        }
    }
    return NULL;
}

static int ECMAOS_JoystickGetCount(void)
{
    return ecmaos_count;
}

static void ECMAOS_JoystickDetect(void)
{
    const Uint64 now = SDL_GetTicks();
    for (int i = 0; i < ECMAOS_PADS; i++) {
        ecmaos_pad *pad = &ecmaos_pads[i];
        if (pad->present) {
            if (!pad->joystick && pad->fd >= 0 && !ECMAOS_ReadPad(pad, ECMAOS_Track, 0)) {
                pad->gone = true;
            }
            if (pad->gone) {
                ECMAOS_RemovePad(pad);
            }
            continue;
        }
        if (pad->fd >= 0) {
            // Opened by an earlier call: the node answers with the state of the pad, or fails
            const bool alive = ECMAOS_ReadPad(pad, ECMAOS_Probe, 0);
            if (alive && (pad->nbuttons > 0 || pad->naxes > 0)) {
                ECMAOS_AddPad(i, pad);
                continue;
            }
            if (alive && now - pad->probed < ECMAOS_PAD_WAIT_MS) {
                continue; // the node is still opening
            }
            ECMAOS_ClosePad(pad);
        }
        if (pad->probed && now - pad->probed < ECMAOS_PAD_PROBE_MS) {
            continue;
        }
        char path[16];
        SDL_snprintf(path, sizeof(path), "/dev/js%d", i);
        pad->probed = now ? now : 1;
        pad->nbuttons = pad->naxes = 0;
        SDL_zeroa(pad->button);
        SDL_zeroa(pad->axis);
        pad->fd = open(path, O_RDONLY | O_NONBLOCK);
    }
}

static bool ECMAOS_JoystickIsDevicePresent(Uint16 vendor_id, Uint16 product_id, Uint16 version, const char *name)
{
    return false;
}

static const char *ECMAOS_JoystickGetDeviceName(int device_index)
{
    ecmaos_pad *pad = ECMAOS_ByIndex(device_index);
    return pad ? pad->name : NULL;
}

static const char *ECMAOS_JoystickGetDevicePath(int device_index)
{
    return NULL;
}

static int ECMAOS_JoystickGetDeviceSteamVirtualGamepadSlot(int device_index)
{
    return -1;
}

static int ECMAOS_JoystickGetDevicePlayerIndex(int device_index)
{
    ecmaos_pad *pad = ECMAOS_ByIndex(device_index);
    return pad ? (int)(pad - ecmaos_pads) : -1;
}

static void ECMAOS_JoystickSetDevicePlayerIndex(int device_index, int player_index)
{
}

static SDL_GUID ECMAOS_JoystickGetDeviceGUID(int device_index)
{
    ecmaos_pad *pad = ECMAOS_ByIndex(device_index);
    SDL_GUID guid;
    SDL_zero(guid);
    return pad ? pad->guid : guid;
}

static SDL_JoystickID ECMAOS_JoystickGetDeviceInstanceID(int device_index)
{
    ecmaos_pad *pad = ECMAOS_ByIndex(device_index);
    return pad ? pad->instance : 0;
}

static bool ECMAOS_JoystickOpen(SDL_Joystick *joystick, int device_index)
{
    ecmaos_pad *pad = ECMAOS_ByIndex(device_index);
    if (!pad) {
        return SDL_SetError("No such device");
    }
    if (pad->joystick) {
        return SDL_SetError("Joystick already opened");
    }
    pad->joystick = joystick;
    pad->fresh = true;
    joystick->hwdata = (struct joystick_hwdata *)pad;
    joystick->nbuttons = pad->nbuttons;
    joystick->naxes = pad->naxes;
    joystick->nhats = 0;
    return true;
}

static bool ECMAOS_JoystickRumble(SDL_Joystick *joystick, Uint16 low_frequency_rumble, Uint16 high_frequency_rumble)
{
    return SDL_Unsupported();
}

static bool ECMAOS_JoystickRumbleTriggers(SDL_Joystick *joystick, Uint16 left_rumble, Uint16 right_rumble)
{
    return SDL_Unsupported();
}

static bool ECMAOS_JoystickSetLED(SDL_Joystick *joystick, Uint8 red, Uint8 green, Uint8 blue)
{
    return SDL_Unsupported();
}

static bool ECMAOS_JoystickSendEffect(SDL_Joystick *joystick, const void *data, int size)
{
    return SDL_Unsupported();
}

static bool ECMAOS_JoystickSetSensorsEnabled(SDL_Joystick *joystick, bool enabled)
{
    return SDL_Unsupported();
}

static void ECMAOS_JoystickUpdate(SDL_Joystick *joystick)
{
    ecmaos_pad *pad = (ecmaos_pad *)joystick->hwdata;
    if (!pad || pad->gone) {
        return;
    }
    const Uint64 ts = SDL_GetTicksNS();
    if (pad->fresh) {
        // What the pad was doing before the program opened it
        pad->fresh = false;
        for (int i = 0; i < pad->nbuttons; i++) {
            if (pad->button[i]) {
                SDL_SendJoystickButton(ts, joystick, i, true);
            }
        }
        for (int i = 0; i < pad->naxes; i++) {
            if (pad->axis[i]) {
                SDL_SendJoystickAxis(ts, joystick, i, pad->axis[i]);
            }
        }
    }
    if (!ECMAOS_ReadPad(pad, ECMAOS_Send, ts)) {
        pad->gone = true; // Detect takes it away
    }
}

static void ECMAOS_JoystickClose(SDL_Joystick *joystick)
{
    ecmaos_pad *pad = (ecmaos_pad *)joystick->hwdata;
    if (pad) {
        pad->joystick = NULL;
    }
}

static void ECMAOS_JoystickQuit(void)
{
    for (int i = 0; i < ECMAOS_PADS; i++) {
        ECMAOS_ClosePad(&ecmaos_pads[i]);
    }
    SDL_zeroa(ecmaos_pads);
    ecmaos_count = 0;
}

static bool ECMAOS_JoystickGetGamepadMapping(int device_index, SDL_GamepadMapping *out)
{
    return false;
}

SDL_JoystickDriver SDL_ECMAOS_JoystickDriver = {
    ECMAOS_JoystickInit,
    ECMAOS_JoystickGetCount,
    ECMAOS_JoystickDetect,
    ECMAOS_JoystickIsDevicePresent,
    ECMAOS_JoystickGetDeviceName,
    ECMAOS_JoystickGetDevicePath,
    ECMAOS_JoystickGetDeviceSteamVirtualGamepadSlot,
    ECMAOS_JoystickGetDevicePlayerIndex,
    ECMAOS_JoystickSetDevicePlayerIndex,
    ECMAOS_JoystickGetDeviceGUID,
    ECMAOS_JoystickGetDeviceInstanceID,
    ECMAOS_JoystickOpen,
    ECMAOS_JoystickRumble,
    ECMAOS_JoystickRumbleTriggers,
    ECMAOS_JoystickSetLED,
    ECMAOS_JoystickSendEffect,
    ECMAOS_JoystickSetSensorsEnabled,
    ECMAOS_JoystickUpdate,
    ECMAOS_JoystickClose,
    ECMAOS_JoystickQuit,
    ECMAOS_JoystickGetGamepadMapping
};

#endif // SDL_JOYSTICK_ECMAOS
SOURCE
  )
  mkdir -p "$work/sdl-build"
  ( cd "$work/sdl-build"
    PKG_CONFIG_PATH="$work/prefix/lib/pkgconfig" emcmake cmake "../SDL3-$SDL" -G Ninja -DCMAKE_BUILD_TYPE=MinSizeRel \
      -DCMAKE_INSTALL_PREFIX="$work/prefix" -DCMAKE_C_FLAGS="-fwasm-exceptions -DSDL_AUDIO_DRIVER_ECMAOS=1 -DSDL_JOYSTICK_ECMAOS=1 -DSDL_VIDEO_STATIC_ANGLE=1" \
      -DSDL_ECMAOS=ON -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TESTS=OFF -DSDL_EXAMPLES=OFF -DSDL_INSTALL_DOCS=OFF \
      -DSDL_WAYLAND=ON -DSDL_WAYLAND_SHARED=OFF -DSDL_WAYLAND_LIBDECOR=OFF \
      -DSDL_X11=OFF -DSDL_KMSDRM=OFF -DSDL_OPENGL=OFF -DSDL_OPENGLES=ON -DSDL_VULKAN=OFF \
      -DSDL_AUDIO=ON -DSDL_DUMMYAUDIO=OFF -DSDL_DISKAUDIO=OFF -DSDL_CAMERA=OFF -DSDL_JOYSTICK=ON -DSDL_HAPTIC=OFF -DSDL_SENSOR=OFF \
      -DSDL_DBUS=OFF -DSDL_IBUS=OFF -DSDL_LIBURING=OFF -DSDL_PIPEWIRE=OFF -DSDL_PULSEAUDIO=OFF -DSDL_ALSA=OFF \
      -DSDL_JACK=OFF -DSDL_SNDIO=OFF -DSDL_OSS=OFF > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
    grep -q "Video drivers:.*wayland" configure.log || { echo "sdl: the Wayland driver was not enabled" >&2; tail -30 configure.log >&2; exit 1; }
    ninja > build.log 2>&1 || { tail -40 build.log >&2; exit 1; }
    ninja install > install.log 2>&1 || { tail -20 install.log >&2; exit 1; }
  )
  SDL_INC="-I$work/prefix/include"
  SDL_LIB="-L$work/prefix/lib -lSDL3"
  SDL_DEPS_LIB="-L$work/prefix/lib -lwayland-cursor -lwayland-egl -lwayland-client -lxkbcommon"
}
