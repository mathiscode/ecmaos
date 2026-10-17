// Plays a 440 Hz tone through SDL 3's audio (the ecmaOS driver, /dev/dsp1) for a while and reports what happened.
// Built by sdl-audio.build.sh.
#include <SDL3/SDL.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static int requested = 0;
static double phase = 0;

static void SDLCALL feed(void *userdata, SDL_AudioStream *stream, int additional, int total) {
  float samples[512];
  while (additional > 0) {
    int n = additional / (int)sizeof(float);
    if (n > 512) n = 512;
    if (n <= 0) break;
    for (int i = 0; i < n; i++) {
      samples[i] = 0.5f * (float)sin(phase);
      phase += 2 * M_PI * 440.0 / 22050.0;
    }
    SDL_PutAudioStreamData(stream, samples, n * (int)sizeof(float));
    additional -= n * (int)sizeof(float);
    requested += n * (int)sizeof(float);
  }
}

int main(int argc, char **argv) {
  int ms = argc > 1 ? atoi(argv[1]) : 500;
  if (!SDL_Init(SDL_INIT_AUDIO)) { printf("init failed: %s\n", SDL_GetError()); return 1; }
  printf("driver=%s\n", SDL_GetCurrentAudioDriver());
  SDL_AudioSpec want = { SDL_AUDIO_F32, 1, 22050 };
  SDL_AudioStream *stream = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &want, feed, NULL);
  if (!stream) { printf("open failed: %s\n", SDL_GetError()); return 1; }
  SDL_AudioSpec have;
  int frames = 0;
  SDL_GetAudioDeviceFormat(SDL_GetAudioStreamDevice(stream), &have, &frames);
  printf("device=%d Hz %d channels format=0x%x\n", have.freq, have.channels, (unsigned)have.format);
  SDL_ResumeAudioStreamDevice(stream);
  Uint64 start = SDL_GetTicks();
  while (SDL_GetTicks() - start < (Uint64)ms) {
    SDL_PumpEvents();
    SDL_Delay(5);
  }
  printf("fed=%s\n", requested > 0 ? "yes" : "no");
  SDL_DestroyAudioStream(stream);
  SDL_Quit();
  printf("done\n");
  return 0;
}
