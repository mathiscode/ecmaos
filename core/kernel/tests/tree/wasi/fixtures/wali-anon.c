/* Anonymous mappings on WALI's musl: one given back and mapped again is zeroes, whether it was written as mapped or
 * after mprotect gave a PROT_NONE one access (the host leaves only what nothing could write uncleared), and a probe
 * of the memory's size the way libc-test's vmfill makes one (gigabytes mapped PROT_NONE and given back, over and
 * over) is quick. The host gives a range back first-fit, so the second mapping is where the first was. */
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>

#define SIZE (256 * 1024)

static int zeroes(const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n; i++) if (p[i]) return 0;
  return 1;
}

static long long ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

int main(void) {
  unsigned char *p = mmap(0, SIZE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memset(p, 0xaa, SIZE);
  munmap(p, SIZE);
  unsigned char *q = mmap(0, SIZE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  printf("written: same=%d zeroes=%d\n", q == p, zeroes(q, SIZE));
  munmap(q, SIZE);

  p = mmap(0, SIZE, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  int protect = mprotect(p + 4096, SIZE - 8192, PROT_READ | PROT_WRITE);
  memset(p + 4096, 0x55, SIZE - 8192);
  munmap(p, SIZE);
  q = mmap(0, SIZE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  printf("after mprotect: %d same=%d zeroes=%d\n", protect, q == p, zeroes(q, SIZE));
  munmap(q, SIZE);

  long long start = ms();
  size_t most = 0;
  for (size_t n = 1u << 30; n >= 4096; n /= 2) {
    void *r = mmap(0, most + n, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (r == MAP_FAILED) continue;
    munmap(r, most + n);
    most += n;
  }
  printf("probe: found=%d quick=%d\n", most >= (64u << 20), ms() - start < 2000);
  return 0;
}
