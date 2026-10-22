/* Threads on WALI's musl: mutexes, condition variables, thread-local storage, malloc from many threads at once,
 * detached threads, the process and thread ids, and exit() or a trap in a thread ending the process. The program starts a
 * copy of itself in the role named by argv[1]; with no role it runs the checks and prints what it found. */
#define _GNU_SOURCE
#include <pthread.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>

extern char **environ;

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static long counter;
static _Thread_local int mine;

static void *count(void *arg) {
  mine = (int)(long)arg;
  for (int i = 0; i < 10000; i++) {
    pthread_mutex_lock(&lock);
    counter++;
    pthread_mutex_unlock(&lock);
  }
  return (void *)(long)(mine * 10);
}

/* a turn passed back and forth: each side waits for its own number */
static pthread_cond_t turned = PTHREAD_COND_INITIALIZER;
static int turn, passes;

static void *pong(void *arg) {
  (void)arg;
  for (int i = 0; i < 100; i++) {
    pthread_mutex_lock(&lock);
    while (turn != 1) pthread_cond_wait(&turned, &lock);
    turn = 0;
    passes++;
    pthread_cond_signal(&turned);
    pthread_mutex_unlock(&lock);
  }
  return 0;
}

static void *churn(void *arg) {
  unsigned seed = (unsigned)(long)arg;
  void *held[64] = {0};
  long sum = 0;
  for (int i = 0; i < 2000; i++) {
    int slot = rand_r(&seed) % 64;
    free(held[slot]);
    size_t size = 1 + rand_r(&seed) % (i % 50 ? 512 : 70000);
    held[slot] = malloc(size);
    memset(held[slot], slot, size);
    sum += ((unsigned char *)held[slot])[size - 1] == slot;
  }
  for (int i = 0; i < 64; i++) free(held[i]);
  return (void *)sum;
}

static int ends[2];
static void *detached(void *arg) {
  char byte = (char)(long)arg;
  write(ends[1], &byte, 1);
  return 0;
}

static pid_t tids[2];
static void *ids(void *arg) {
  (void)arg;
  tids[0] = getpid();
  tids[1] = gettid();
  return 0;
}

static void *leave(void *arg) {
  (void)arg;
  usleep(20000);
  exit(9);
}

static void *fault(void *arg) {
  (void)arg;
  usleep(20000);
  __builtin_trap();
}

int main(int argc, char **argv) {
  if (argc > 1 && (!strcmp(argv[1], "exit") || !strcmp(argv[1], "trap"))) { /* while the first thread waits */
    pthread_t t;
    pthread_create(&t, 0, !strcmp(argv[1], "exit") ? leave : fault, 0);
    pthread_join(t, 0);
    return 0;
  }
  setvbuf(stdout, 0, _IONBF, 0);

  pthread_t t[8];
  for (long i = 0; i < 8; i++) pthread_create(&t[i], 0, count, (void *)(i + 1));
  long returned = 0;
  for (int i = 0; i < 8; i++) {
    void *value;
    pthread_join(t[i], &value);
    returned += (long)value;
  }
  printf("mutex: counter=%ld returned=%ld tls main=%d\n", counter, returned, mine);

  pthread_t other;
  pthread_create(&other, 0, pong, 0);
  for (int i = 0; i < 100; i++) {
    pthread_mutex_lock(&lock);
    while (turn != 0) pthread_cond_wait(&turned, &lock);
    turn = 1;
    pthread_cond_signal(&turned);
    pthread_mutex_unlock(&lock);
  }
  pthread_join(other, 0);
  printf("condvar: passes=%d\n", passes);

  for (long i = 0; i < 4; i++) pthread_create(&t[i], 0, churn, (void *)(i + 7));
  long fine = 0;
  for (int i = 0; i < 4; i++) {
    void *value;
    pthread_join(t[i], &value);
    fine += (long)value;
  }
  printf("malloc: %ld of 8000 blocks intact\n", fine);

  pipe(ends);
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  for (long i = 0; i < 5; i++) pthread_create(&t[i], &attr, detached, (void *)('a' + i));
  char got[8] = {0};
  for (int n = 0; n < 5;) n += read(ends[0], got + n, 5 - n);
  int seen = 0;
  for (int i = 0; i < 5; i++) seen |= 1 << (got[i] - 'a');
  printf("detached: %d threads wrote\n", __builtin_popcount(seen));

  pthread_create(&other, 0, ids, 0);
  pthread_join(other, 0);
  printf("ids: same pid=%d other tid=%d\n", tids[0] == getpid(), tids[1] != gettid() && tids[1] > 0);

  pid_t pid;
  int status;
  posix_spawn(&pid, argv[0], 0, 0, (char *[]){ argv[0], "exit", 0 }, environ);
  waitpid(pid, &status, 0);
  printf("exit from a thread: exit=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);

  /* the trap's message goes to the child's stderr, which is put away here */
  posix_spawn_file_actions_t quiet;
  posix_spawn_file_actions_init(&quiet);
  posix_spawn_file_actions_addopen(&quiet, 2, "/dev/null", O_WRONLY, 0);
  posix_spawn(&pid, argv[0], &quiet, 0, (char *[]){ argv[0], "trap", 0 }, environ);
  waitpid(pid, &status, 0);
  printf("trap in a thread: exit=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
  return 0;
}
