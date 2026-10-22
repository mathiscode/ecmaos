/* Signals to a WALI program that is busy computing, making no syscalls: its loops look for them now and then
 * (utils/wali/signal-checks.mjs). A handler runs in the middle of a loop, even a leaf function's, whose locals below
 * the stack pointer it leaves alone; and a process stopped in a loop stays stopped, running no handler, until it is
 * continued (which only the kernel can see: whatever it did would reach the world by a syscall, which is held). The program starts copies of itself in the role named by argv[1]; with no role it runs the checks. */
#define _GNU_SOURCE
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static const char *self;
static volatile sig_atomic_t fired;

static void on_signal(int signal) {
  /* a frame of its own, well past any red zone below the interrupted function's */
  volatile char scratch[512];
  for (unsigned i = 0; i < sizeof scratch; i++) scratch[i] = 0x55;
  fired = signal;
}

/* a leaf: its locals live below the stack pointer, which it never moves */
__attribute__((noinline)) static int leaf_spin(void) {
  volatile int words[16];
  for (int i = 0; i < 16; i++) words[i] = i;
  while (!fired) for (int i = 0; i < 16; i++) words[i] += 16;
  int intact = 1;
  for (int i = 1; i < 16; i++) intact &= words[i] - words[i - 1] == 1;
  return intact;
}

/* the child: says it is ready, then computes until a signal's handler ends it */
static int spin(void) {
  signal(SIGUSR1, on_signal);
  write(1, "r", 1);
  unsigned long spins = 0;
  while (!fired) spins++;
  return fired == SIGUSR1 ? 7 : 1;
}

static pid_t start(int *ready) {
  int ends[2];
  pipe(ends);
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, ends[1], 1);
  posix_spawn_file_actions_addclose(&actions, ends[0]);
  char *argv[] = { "wali-busy", "spin", 0 };
  pid_t pid;
  if (posix_spawn(&pid, self, &actions, 0, argv, environ)) pid = -1;
  close(ends[1]);
  char byte;
  *ready = read(ends[0], &byte, 1) == 1;
  close(ends[0]);
  return pid;
}

int main(int argc, char **argv) {
  self = argv[0];
  if (argc > 1 && !strcmp(argv[1], "spin")) return spin();

  signal(SIGALRM, on_signal);
  alarm(1);
  unsigned long spins = 0;
  while (!fired) spins++;
  printf("alarm while computing: fired=%d\n", fired == SIGALRM);

  fired = 0;
  alarm(1);
  printf("leaf: locals intact=%d\n", leaf_spin());

  int ready, status;
  pid_t child = start(&ready);
  kill(child, SIGUSR1);
  waitpid(child, &status, 0);
  printf("child computing: ready=%d exit=%d\n", ready, WIFEXITED(status) ? WEXITSTATUS(status) : -1);

  child = start(&ready);
  kill(child, SIGSTOP);
  waitpid(child, &status, WUNTRACED);
  int stopped = WIFSTOPPED(status);
  usleep(300000);
  kill(child, SIGUSR1);
  usleep(500000);
  int still = waitpid(child, &status, WNOHANG) == 0;
  kill(child, SIGCONT);
  waitpid(child, &status, 0);
  printf("stopped computing: stopped=%d held=%d exit=%d\n", stopped, still, WIFEXITED(status) ? WEXITSTATUS(status) : -1);
  return 0;
}
