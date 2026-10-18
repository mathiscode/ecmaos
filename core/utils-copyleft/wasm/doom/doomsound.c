/* SPDX-License-Identifier: GPL-2.0-or-later
 * Sound effects for doom on ecmaOS: a small mixer behind doomgeneric's sound_module_t, played through an SDL 3 audio stream
 * (SDL_mixer is not available). Doom's sounds are 8-bit mono lumps; each channel steps through its lump at the lump's rate,
 * panned and scaled by the engine's volume and separation, and the sum goes to the stream as 16-bit stereo. The engine calls
 * Update about 35 times a second, which keeps a few tics of audio queued. There is no music yet: its module does nothing. */
#include <SDL3/SDL.h>
#include <stdlib.h>
#include <string.h>
#include "doomtype.h"
#include "deh_str.h"
#include "i_sound.h"
#include "m_misc.h"
#include "w_wad.h"
#include "z_zone.h"

#define RATE 22050
#define CHANNELS 16
#define QUEUE_FRAMES (RATE / 35 * 4)   /* about four tics queued */

int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

typedef struct { const byte *data; int length, rate; } sample_t;
typedef struct { const sample_t *sample; unsigned pos, step; int left, right; } voice_t;   /* pos and step are 16.16 */

static SDL_AudioStream *stream;
static voice_t voices[CHANNELS];
static boolean prefix = true;

static void pan(voice_t *v, int vol, int sep)
{
  int l = (254 - sep) * vol / 127, r = sep * vol / 127;   /* 0..127 for vol at 127 and sep in the middle */
  v->left = l > 127 ? 127 : l < 0 ? 0 : l;
  v->right = r > 127 ? 127 : r < 0 ? 0 : r;
}

static boolean snd_init(boolean use_sfx_prefix)
{
  prefix = use_sfx_prefix;
  if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) return false;
  SDL_AudioSpec spec = { SDL_AUDIO_S16, 2, RATE };
  stream = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);
  if (!stream) return false;
  SDL_ResumeAudioStreamDevice(stream);
  return true;
}

static void snd_shutdown(void)
{
  if (stream) SDL_DestroyAudioStream(stream);
  stream = NULL;
}

static int snd_lump(sfxinfo_t *sfx)
{
  char name[9];
  if (sfx->link) sfx = sfx->link;
  if (prefix) M_snprintf(name, sizeof name, "ds%s", DEH_String(sfx->name));
  else M_StringCopy(name, DEH_String(sfx->name), sizeof name);
  return W_GetNumForName(name);
}

/* the lump is a 8 byte header (3, 0, rate, length) around the samples; DMX leaves out 16 bytes at each end */
static const sample_t *load(sfxinfo_t *sfx)
{
  if (sfx->driver_data) return sfx->driver_data;
  int lump = sfx->lumpnum;
  const byte *d = W_CacheLumpNum(lump, PU_STATIC);
  unsigned size = W_LumpLength(lump);
  if (size < 8 || d[0] != 3 || d[1] != 0) return NULL;
  unsigned length = d[4] | d[5] << 8 | d[6] << 16 | (unsigned)d[7] << 24;
  if (length > size - 8 || length <= 48) return NULL;
  sample_t *s = malloc(sizeof *s);
  s->data = d + 8 + 16;
  s->length = length - 32;
  s->rate = d[2] | d[3] << 8;
  if (s->rate <= 0) s->rate = 11025;
  sfx->driver_data = s;
  return s;
}

static int snd_start(sfxinfo_t *sfx, int channel, int vol, int sep)
{
  if (!stream || channel < 0 || channel >= CHANNELS) return -1;
  const sample_t *s = load(sfx);
  if (!s) return -1;
  voice_t *v = &voices[channel];
  v->sample = NULL;
  v->pos = 0;
  v->step = (unsigned)((unsigned long long)s->rate * 65536 / RATE);
  pan(v, vol, sep);
  v->sample = s;
  return channel;
}

static void snd_update_params(int channel, int vol, int sep)
{
  if (channel >= 0 && channel < CHANNELS) pan(&voices[channel], vol, sep);
}

static void snd_stop(int channel)
{
  if (channel >= 0 && channel < CHANNELS) voices[channel].sample = NULL;
}

static boolean snd_playing(int channel)
{
  return channel >= 0 && channel < CHANNELS && voices[channel].sample != NULL;
}

static void snd_update(void)
{
  if (!stream) return;
  int queued = SDL_GetAudioStreamQueued(stream) / 4;
  while (queued < QUEUE_FRAMES) {
    Sint16 out[2 * 256];
    int n = QUEUE_FRAMES - queued < 256 ? QUEUE_FRAMES - queued : 256;
    for (int i = 0; i < n; i++) {
      int l = 0, r = 0;
      for (int c = 0; c < CHANNELS; c++) {
        voice_t *v = &voices[c];
        if (!v->sample) continue;
        unsigned at = v->pos >> 16;
        if ((int)at >= v->sample->length) { v->sample = NULL; continue; }
        int x = ((int)v->sample->data[at] - 128) << 8;   /* 8-bit unsigned to 16-bit signed */
        l += x * v->left / 127 / 2;   /* each voice at most half scale, so a couple together do not clip at once */
        r += x * v->right / 127 / 2;
        v->pos += v->step;
      }
      out[2 * i] = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
      out[2 * i + 1] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
    }
    SDL_PutAudioStreamData(stream, out, n * 4);
    queued += n;
  }
}

static snddevice_t devices[] = { SNDDEVICE_SB, SNDDEVICE_PAS, SNDDEVICE_GUS, SNDDEVICE_WAVEBLASTER, SNDDEVICE_SOUNDCANVAS, SNDDEVICE_AWE32 };

sound_module_t DG_sound_module = {
  devices, sizeof devices / sizeof devices[0],
  snd_init, snd_shutdown, snd_lump, snd_update, snd_update_params, snd_start, snd_stop, snd_playing, NULL,
};

static boolean mus_init(void) { return true; }
static void mus_none(void) {}
static void mus_volume(int v) { (void)v; }
static void *mus_register(void *d, int l) { (void)d; (void)l; return NULL; }
static void mus_unregister(void *h) { (void)h; }
static void mus_play(void *h, boolean loop) { (void)h; (void)loop; }
static boolean mus_playing(void) { return false; }

music_module_t DG_music_module = {
  devices, sizeof devices / sizeof devices[0],
  mus_init, mus_none, mus_volume, mus_none, mus_none, mus_register, mus_unregister, mus_play, mus_none, mus_playing, mus_none,
};
