/* The alternate signal stack on WALI's musl: a handler with SA_ONSTACK runs on it, and one without on the thread's
 * own; sigaltstack says SS_ONSTACK from a handler running on it, and refuses to change it there; SS_AUTODISARM takes
 * it away for the handler and gives it back after; a handler that leaves by siglongjmp leaves it too; a nested handler
 * stays on it; a new thread has none; and sigaltstack checks what it is given. */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static char stack[SIGSTKSZ];
static volatile int on, flags, changed = -1, nested_on, autodisarm_flags;
static sigjmp_buf jump;

static int here(void) {
  volatile char probe;
  uintptr_t at = (uintptr_t)&probe;
  return at >= (uintptr_t)stack && at < (uintptr_t)stack + sizeof stack;
}

static void nested(int signal) { (void)signal; nested_on = here(); }

static void handler(int signal) {
  (void)signal;
  stack_t ss, other = { .ss_sp = stack, .ss_size = sizeof stack };
  on = here();
  sigaltstack(NULL, &ss);
  flags = ss.ss_flags;
  changed = sigaltstack(&other, NULL) == -1 ? errno : 0;
  raise(SIGUSR2);
}

static void autodisarm(int signal) {
  (void)signal;
  stack_t ss;
  on = here();
  sigaltstack(NULL, &ss);
  autodisarm_flags = ss.ss_flags;
}

static void leave(int signal) {
  (void)signal;
  on = here();
  siglongjmp(jump, 1);
}

static void *thread(void *arg) {
  (void)arg;
  stack_t ss;
  sigaltstack(NULL, &ss);
  return (void *)(intptr_t)ss.ss_flags;
}

static void install(int signal, void (*fn)(int), int sa_flags) {
  struct sigaction sa = { .sa_handler = fn, .sa_flags = sa_flags };
  sigemptyset(&sa.sa_mask);
  sigaction(signal, &sa, NULL);
}

int main(void) {
  stack_t ss = { .ss_sp = stack, .ss_size = sizeof stack }, old;

  sigaltstack(NULL, &old);
  printf("at first: disabled=%d\n", old.ss_flags == SS_DISABLE);

  printf("set: %d\n", sigaltstack(&ss, NULL));
  install(SIGUSR1, handler, SA_ONSTACK);
  install(SIGUSR2, nested, SA_ONSTACK);
  raise(SIGUSR1);
  printf("SA_ONSTACK: on=%d flags=%d change=%s nested on=%d\n", on, flags, strerror(changed), nested_on);

  install(SIGUSR1, handler, 0);
  raise(SIGUSR1);
  printf("without: on=%d\n", on);

  ss.ss_flags = SS_AUTODISARM;
  sigaltstack(&ss, NULL);
  install(SIGUSR1, autodisarm, SA_ONSTACK);
  raise(SIGUSR1);
  sigaltstack(NULL, &old);
  printf("SS_AUTODISARM: on=%d in handler disabled=%d after=%d\n", on, autodisarm_flags == SS_DISABLE,
         old.ss_flags == (int)SS_AUTODISARM);

  ss.ss_flags = 0;
  sigaltstack(&ss, NULL);
  install(SIGUSR1, leave, SA_ONSTACK);
  if (!sigsetjmp(jump, 1)) raise(SIGUSR1);
  sigaltstack(NULL, &old);
  printf("siglongjmp: on=%d off after=%d\n", on, old.ss_flags == 0 && !here());

  pthread_t t;
  void *thread_flags;
  pthread_create(&t, NULL, thread, NULL);
  pthread_join(t, &thread_flags);
  printf("new thread: disabled=%d\n", (int)(intptr_t)thread_flags == SS_DISABLE);

  ss.ss_size = MINSIGSTKSZ - 1;
  errno = 0;
  int small = sigaltstack(&ss, NULL) == -1 ? errno : 0;
  ss.ss_size = MINSIGSTKSZ;
  ss.ss_flags = 4;
  errno = 0;
  int bad = sigaltstack(&ss, NULL) == -1 ? errno : 0;
  ss.ss_flags = SS_DISABLE;
  sigaltstack(&ss, NULL);
  sigaltstack(NULL, &old);
  printf("checks: small=%s bad flags=%s disabled=%d\n", strerror(small), strerror(bad), old.ss_flags == SS_DISABLE);
  return 0;
}
