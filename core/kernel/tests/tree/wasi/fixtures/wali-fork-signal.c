/*
 * fork in a signal handler, for a program built to unwind at its imports (ECMAOS_WALI_ASYNCIFY_SIGNALS=all, see
 * wali.build.sh): the child leaves the handler and goes on from where the signal interrupted the program. The signal
 * is one the program raises (delivered as `raise` returns), one a timer sets off while a loop spins, and one that runs
 * on the alternate stack.
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t fired;
static volatile int is_child;
static volatile int on_alternate;
static pid_t forked;
static char stack[32768];

static void handler(int signal)
{
  char marker;
  fired++;
  if (signal == SIGUSR2) on_alternate = (char *)&marker >= stack && (char *)&marker < stack + sizeof stack;
  pid_t pid = fork();
  if (pid == 0) is_child = 1;
  else forked = pid;
}

static int blocked(int signal)
{
  sigset_t set;
  sigprocmask(SIG_BLOCK, 0, &set);
  return sigismember(&set, signal);
}

/* what each process does once the signal has been handled: the child says what it saw and leaves */
static void report(const char *what, int local, int code)
{
  if (is_child) {
    printf("child %s fired=%d local=%d blocked=%d alternate=%d\n", what, fired, local, blocked(SIGUSR1), on_alternate);
    fflush(stdout);
    _exit(code);
  }
  int status;
  waitpid(forked, &status, 0);
  printf("parent %s exit=%d fired=%d local=%d blocked=%d\n", what, WEXITSTATUS(status), fired, local, blocked(SIGUSR1));
  fflush(stdout);
}

int main(void)
{
  struct sigaction action = { .sa_handler = handler };
  sigaction(SIGUSR1, &action, 0);
  sigaction(SIGALRM, &action, 0);
  stack_t alt = { .ss_sp = stack, .ss_size = sizeof stack };
  sigaltstack(&alt, 0);
  action.sa_flags = SA_ONSTACK;
  sigaction(SIGUSR2, &action, 0);

  int local = 7;
  raise(SIGUSR1);
  local++;
  report("raise", local, 4);

  fired = 0;
  is_child = 0;
  alarm(1);
  while (!fired) local++;
  local = 100;
  report("timer", local, 5);

  fired = 0;
  is_child = 0;
  raise(SIGUSR2);
  local = 200;
  report("altstack", local, 6);
  return 0;
}
