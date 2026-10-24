/*
 * fork in a signal handler for a program that was not built to unwind at its imports: the fork fails with ENOSYS, and
 * the program goes on as it was.
 */
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static volatile int result, error;

static void handler(int signal)
{
  result = fork();
  error = errno;
}

int main(void)
{
  signal(SIGUSR1, handler);
  raise(SIGUSR1);
  printf("fork in handler=%d enosys=%d\n", result, error == ENOSYS);
  /* and a fork outside a handler still works */
  pid_t pid = fork();
  if (pid == 0) _exit(0);
  printf("fork after=%d\n", pid > 0);
  return 0;
}
