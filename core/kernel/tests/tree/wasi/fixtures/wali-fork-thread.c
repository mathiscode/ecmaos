/*
 * fork from a thread other than the first: the child is the process's (the main thread waits for it), has only the
 * thread that forked, with its thread-local values, and can start threads of its own.
 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static __thread int tls = 11;
static pid_t forked, parent;
static int fds[2];
static volatile int inner_ran;

static void *inner(void *arg)
{
  inner_ran = (int)(long)arg;
  return 0;
}

static void *worker(void *arg)
{
  tls = 22;
  pid_t pid = fork();
  if (pid < 0) return (void *)-1;
  if (pid == 0) {
    pthread_t thread;
    pthread_create(&thread, 0, inner, (void *)1);
    pthread_join(thread, 0);
    char text[96];
    int length = snprintf(text, sizeof text, "tls=%d arg=%ld ppid-ok=%d inner=%d", tls, (long)arg, getppid() == parent, inner_ran);
    write(fds[1], text, length);
    _exit(9);
  }
  forked = pid;
  return (void *)5;
}

int main(void)
{
  pipe(fds);
  parent = getpid();
  pthread_t thread;
  void *result;
  pthread_create(&thread, 0, worker, (void *)3);
  pthread_join(thread, &result);
  close(fds[1]);
  char buffer[128] = { 0 };
  read(fds[0], buffer, sizeof buffer - 1);
  int status = 0;
  pid_t reaped = waitpid(forked, &status, 0);
  printf("child %s\nexit=%d reaped=%d joined=%ld main-tls=%d\n", buffer, WEXITSTATUS(status), reaped == forked, (long)result, tls);
  return 0;
}
