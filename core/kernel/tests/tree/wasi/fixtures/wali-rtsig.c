/* Real-time signals on WALI's musl: raised, queued (each one sent is delivered, where a standard signal sent again
 * while pending merges), sent between threads with pthread_kill, waited for with sigwaitinfo and sigtimedwait, sent
 * with sigqueue, and ending a process that does not handle one. The program starts copies of itself in the roles
 * named by argv[1]; with no role it runs the checks and prints what it found. */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static const char *self;
static volatile int counts[65];

static void count(int signal) { counts[signal]++; }

static pid_t start(const char *role, int signal, int times) {
  char sig[8], n[8];
  snprintf(sig, sizeof sig, "%d", signal);
  snprintf(n, sizeof n, "%d", times);
  char *argv[] = { "wali-rtsig", (char *)role, sig, n, 0 };
  pid_t pid;
  return posix_spawn(&pid, self, 0, 0, argv, environ) ? -1 : pid;
}

static void *spin(void *arg) {
  (void)arg;
  while (counts[SIGRTMIN + 2] < 100);
  return 0;
}

int main(int argc, char **argv) {
  self = argv[0];
  /* sends its parent a signal so many times */
  if (argc > 3 && !strcmp(argv[1], "send")) {
    for (int i = atoi(argv[3]); i > 0; i--) kill(getppid(), atoi(argv[2]));
    return 0;
  }
  /* waits to be ended by a signal it does not handle */
  if (argc > 1 && !strcmp(argv[1], "wait")) {
    pause();
    return 3;
  }

  printf("range: SIGRTMIN=%d SIGRTMAX=%d\n", SIGRTMIN, SIGRTMAX);

  signal(SIGRTMIN, count);
  int failed = 0;
  for (int i = 0; i < 1000; i++) failed += raise(SIGRTMIN) != 0;
  printf("raise: delivered=%d failed=%d\n", counts[SIGRTMIN], failed);

  sigset_t set, none;
  sigemptyset(&set);
  sigemptyset(&none);
  sigaddset(&set, SIGRTMIN + 1);
  sigaddset(&set, SIGUSR1);
  signal(SIGRTMIN + 1, count);
  signal(SIGUSR1, count);
  sigprocmask(SIG_BLOCK, &set, 0);
  int status;
  waitpid(start("send", SIGRTMIN + 1, 5), &status, 0);
  waitpid(start("send", SIGUSR1, 5), &status, 0);
  usleep(100000);
  sigprocmask(SIG_SETMASK, &none, 0);
  printf("queued while blocked: real-time=%d SIGUSR1=%d\n", counts[SIGRTMIN + 1], counts[SIGUSR1]);

  signal(SIGRTMIN + 2, count);
  pthread_t thread;
  pthread_create(&thread, 0, spin, 0);
  failed = 0;
  for (int i = 0; i < 100; i++) failed += pthread_kill(thread, SIGRTMIN + 2) != 0;
  pthread_join(thread, 0);
  printf("pthread_kill to a thread computing: delivered=%d failed=%d\n", counts[SIGRTMIN + 2], failed);

  sigemptyset(&set);
  sigaddset(&set, SIGRTMIN + 3);
  sigprocmask(SIG_BLOCK, &set, 0);
  waitpid(start("send", SIGRTMIN + 3, 2), &status, 0);
  siginfo_t info;
  int first = sigwaitinfo(&set, &info), second = sigwaitinfo(&set, &info);
  struct timespec brief = { 0, 100000000 };
  int none_left = sigtimedwait(&set, &info, &brief);
  printf("sigwaitinfo: %d %d signo=%d, then timed out=%d\n", first - SIGRTMIN, second - SIGRTMIN, info.si_signo - SIGRTMIN, none_left == -1 && errno == EAGAIN);
  sigprocmask(SIG_SETMASK, &none, 0);

  signal(SIGRTMIN + 4, count);
  sigqueue(getpid(), SIGRTMIN + 4, (union sigval){ .sival_int = 7 });
  printf("sigqueue: delivered=%d\n", counts[SIGRTMIN + 4]);

  pid_t waiting = start("wait", 0, 0);
  usleep(100000);
  kill(waiting, SIGRTMIN + 5);
  waitpid(waiting, &status, 0);
  printf("unhandled: signaled=%d by=%d\n", WIFSIGNALED(status), WIFSIGNALED(status) ? WTERMSIG(status) - SIGRTMIN : -1);
  return 0;
}
