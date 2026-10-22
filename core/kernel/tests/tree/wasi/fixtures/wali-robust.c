/* Robust and priority-inheritance mutexes on WALI's musl: the attributes are taken (musl asks for get_robust_list and
 * FUTEX_LOCK_PI first); a robust mutex whose owner ends holding it, by pthread_exit (which musl gives up itself) or by
 * a bare SYS_exit (which the host gives up from the thread's robust list, where musl puts a process-shared one; a
 * private one it keeps to itself, as on Linux), is the next locker's with EOWNERDEAD; a priority-inheritance mutex
 * keeps a count right between threads, is busy to trylock while another holds it, and is handed on when its owner
 * ends without unlocking, even off any robust list (as Linux hands on a dead owner's priority-inheritance locks). */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static pthread_mutex_t mutex;
static pthread_barrier_t barrier;
static long counter;

static void init(int robust, int pi, int pshared) {
  pthread_mutexattr_t attr;
  pthread_mutexattr_init(&attr);
  if (robust) pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST);
  if (pshared) pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
  if (pi) pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);
  pthread_mutex_init(&mutex, &attr);
  pthread_mutexattr_destroy(&attr);
}

/* locks the mutex and ends, by returning or by a bare SYS_exit, never unlocking it */
static void *hold(void *bare) {
  pthread_mutex_lock(&mutex);
  pthread_barrier_wait(&barrier);
  if (bare) syscall(SYS_exit, 0);
  return 0;
}

/* two seconds at most, so a lock nobody gives up fails rather than hangs */
static int lock_soon(void) {
  struct timespec at;
  clock_gettime(CLOCK_REALTIME, &at);
  at.tv_sec += 2;
  return pthread_mutex_timedlock(&mutex, &at);
}

static const char *orphaned(int pi, int bare, int pshared) {
  static char out[80];
  pthread_t t;
  init(1, pi, pshared);
  pthread_barrier_init(&barrier, 0, 2);
  pthread_create(&t, 0, hold, bare ? &t : 0);
  if (!bare) pthread_detach(t);
  pthread_barrier_wait(&barrier);
  pthread_barrier_destroy(&barrier);
  int r = lock_soon(), consistent = r == EOWNERDEAD ? pthread_mutex_consistent(&mutex) : -1;
  pthread_mutex_unlock(&mutex);
  int again = lock_soon();
  pthread_mutex_unlock(&mutex);
  pthread_mutex_destroy(&mutex);
  snprintf(out, sizeof out, "%s consistent=%d again=%d", strerror(r), consistent, again);
  return out;
}

static void *count(void *arg) {
  (void)arg;
  for (int i = 0; i < 20000; i++) {
    pthread_mutex_lock(&mutex);
    counter++;
    pthread_mutex_unlock(&mutex);
  }
  return 0;
}

static void *try_held(void *arg) {
  (void)arg;
  return (void *)(long)pthread_mutex_trylock(&mutex);
}

int main(void) {
  pthread_mutexattr_t attr;
  pthread_mutexattr_init(&attr);
  printf("attributes: robust=%d inherit=%d\n", pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST),
         pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT));

  printf("robust, pthread_exit: %s\n", orphaned(0, 0, 0));
  printf("robust, bare exit: %s\n", orphaned(0, 1, 1));

  init(0, 1, 0);
  pthread_t threads[4];
  for (int i = 0; i < 4; i++) pthread_create(&threads[i], 0, count, 0);
  for (int i = 0; i < 4; i++) pthread_join(threads[i], 0);
  pthread_mutex_lock(&mutex);
  void *tried;
  pthread_create(&threads[0], 0, try_held, 0);
  pthread_join(threads[0], &tried);
  pthread_mutex_unlock(&mutex);
  printf("inherit: counter=%ld trylock held=%s again=%d\n", counter, strerror((int)(long)tried), pthread_mutex_trylock(&mutex));
  pthread_mutex_unlock(&mutex);
  pthread_mutex_destroy(&mutex);

  printf("robust inherit, pthread_exit: %s\n", orphaned(1, 0, 0));
  printf("robust inherit, bare exit: %s\n", orphaned(1, 1, 1));
  printf("robust inherit, private, bare exit: %s\n", orphaned(1, 1, 0));
  return 0;
}
