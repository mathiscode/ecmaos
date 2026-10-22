/* The wall clock on WALI's musl: read finer than a millisecond, never going back, and agreeing with gettimeofday and
 * time. */
#include <stdio.h>
#include <sys/time.h>
#include <time.h>

static double ms(struct timespec t) { return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

int main(void) {
  struct timespec start, previous, t, res;
  clock_gettime(CLOCK_REALTIME, &start);
  previous = start;
  int fine = 0, backwards = 0, readings = 0;
  do {
    clock_gettime(CLOCK_REALTIME, &t);
    readings++;
    if (t.tv_nsec % 1000000) fine++;
    if (ms(t) < ms(previous)) backwards++;
    previous = t;
  } while (ms(t) - ms(start) < 50);
  printf("realtime: fine=%d backwards=%d\n", fine > readings / 2, backwards);

  // within a millisecond of each other, gettimeofday reading microseconds
  struct timeval tv;
  int micro = 0;
  for (int i = 0; i < 1000; i++) {
    gettimeofday(&tv, NULL);
    if (tv.tv_usec % 1000) micro++;
  }
  clock_gettime(CLOCK_REALTIME, &t);
  gettimeofday(&tv, NULL);
  double gap = tv.tv_sec * 1e3 + tv.tv_usec / 1e3 - ms(t);
  printf("gettimeofday: micro=%d agrees=%d\n", micro > 500, gap >= 0 && gap < 1);

  time_t now = time(NULL);
  clock_gettime(CLOCK_REALTIME, &t);
  printf("time: agrees=%d\n", t.tv_sec - now >= 0 && t.tv_sec - now <= 1);

  clock_getres(CLOCK_REALTIME, &res);
  printf("getres: below a millisecond=%d\n", res.tv_sec == 0 && res.tv_nsec > 0 && res.tv_nsec < 1000000);
  return 0;
}
