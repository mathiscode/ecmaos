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
#   - nothing else: no OpenGL, no joysticks, no libdecor.
set -euo pipefail

SDL=3.4.18
SDL_SHA256=9c75cf16330322c217dedd2e0609f1124f1b54b8633e763467b4684d0f4334a3

build_sdl() {
  local work=$1
  command -v cmake > /dev/null || { echo "sdl: needs the host cmake" >&2; exit 1; }
  command -v ninja > /dev/null || { echo "sdl: needs the host ninja" >&2; exit 1; }
  command -v pkg-config > /dev/null || { echo "sdl: needs the host pkg-config" >&2; exit 1; }
  ( cd "$work"
    curl -fsSL -o sdl.tar.gz "https://github.com/libsdl-org/SDL/releases/download/release-$SDL/SDL3-$SDL.tar.gz"
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
  )
  mkdir -p "$work/sdl-build"
  ( cd "$work/sdl-build"
    PKG_CONFIG_PATH="$work/prefix/lib/pkgconfig" emcmake cmake "../SDL3-$SDL" -G Ninja -DCMAKE_BUILD_TYPE=MinSizeRel \
      -DCMAKE_INSTALL_PREFIX="$work/prefix" -DCMAKE_C_FLAGS="-fwasm-exceptions -DSDL_AUDIO_DRIVER_ECMAOS=1" \
      -DSDL_ECMAOS=ON -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TESTS=OFF -DSDL_EXAMPLES=OFF -DSDL_INSTALL_DOCS=OFF \
      -DSDL_WAYLAND=ON -DSDL_WAYLAND_SHARED=OFF -DSDL_WAYLAND_LIBDECOR=OFF \
      -DSDL_X11=OFF -DSDL_KMSDRM=OFF -DSDL_OPENGL=OFF -DSDL_OPENGLES=OFF -DSDL_VULKAN=OFF \
      -DSDL_AUDIO=ON -DSDL_DUMMYAUDIO=OFF -DSDL_DISKAUDIO=OFF -DSDL_CAMERA=OFF -DSDL_JOYSTICK=OFF -DSDL_HAPTIC=OFF -DSDL_SENSOR=OFF \
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
