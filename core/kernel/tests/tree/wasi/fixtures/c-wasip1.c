/* Plain C against WASI only: built with emcc -sSTANDALONE_WASM, so the module imports nothing but
   wasi_snapshot_preview1 (the shape wasi-sdk produces). Arguments, environment, stdout/stderr, a clock and an exit code (emcc's standalone libc has no path calls). */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  printf("argc=%d\n", argc);
  for (int i = 1; i < argc; i++) printf("arg=%s\n", argv[i]);
  const char *home = getenv("HOME");
  printf("home=%s\n", home ? home : "");
  fprintf(stderr, "c-wasip1: stderr\n");

  printf("clock=%d\n", time(NULL) > 1700000000);
  return argc > 1 ? atoi(argv[1]) : 0;
}
