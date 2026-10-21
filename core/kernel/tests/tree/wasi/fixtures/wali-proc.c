/* Processes and signals on WALI's musl: posix_spawn through the host, wait, exec, and signal delivery. The program
 * starts copies of itself in the roles named by argv[1]; with no role it runs the checks and prints what it found. */
#include <errno.h>
#include <fcntl.h>
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
static volatile sig_atomic_t usr1, alrm, chld;

static void on_usr1(int signal) { (void)signal; usr1++; }
static void on_alrm(int signal) { (void)signal; alrm++; }
static void on_chld(int signal) { (void)signal; chld++; }

static int run(char *const argv[], posix_spawn_file_actions_t *actions, posix_spawnattr_t *attr) {
  pid_t pid;
  int error = posix_spawn(&pid, self, actions, attr, argv, environ);
  if (error) return -error;
  int status;
  if (waitpid(pid, &status, 0) != pid) return -1000;
  return status;
}

/* --- the roles a child plays --- */

static int child(int argc, char **argv) {
  const char *role = argv[1];
  if (!strcmp(role, "write")) {           /* says something on stdout and exits 7 */
    printf("from the child\n");
    return 7;
  }
  if (!strcmp(role, "fds")) {             /* which of the descriptors named are open here */
    for (int i = 2; i < argc; i++) printf("%s%d=%s", i > 2 ? " " : "", atoi(argv[i]), fcntl(atoi(argv[i]), F_GETFD) < 0 ? "closed" : "open");
    printf("\n");
    return 0;
  }
  if (!strcmp(role, "signals")) {         /* what it inherited: SIGUSR2 ignored, SIGUSR1 blocked */
    sigset_t mask;
    sigprocmask(SIG_BLOCK, 0, &mask);
    raise(SIGUSR2);                       /* ignored, so it lives */
    printf("usr2 survived, usr1 blocked=%d\n", sigismember(&mask, SIGUSR1));
    return 0;
  }
  if (!strcmp(role, "exec")) {            /* becomes "fds" with a close-on-exec descriptor and a plain one */
    int keep = open("/tmp/wali-proc-keep", O_RDONLY | O_CREAT, 0644);
    int lose = open("/tmp/wali-proc-keep", O_RDONLY | O_CLOEXEC);
    char a[16], b[16];
    snprintf(a, sizeof a, "%d", keep);
    snprintf(b, sizeof b, "%d", lose);
    execl(self, self, "fds", a, b, (char *)0);
    return 99;
  }
  if (!strcmp(role, "term")) {            /* dies of SIGTERM */
    raise(SIGTERM);
    return 0;
  }
  if (!strcmp(role, "slow")) {            /* takes a moment */
    usleep(300 * 1000);
    return 3;
  }
  return 100;
}

int main(int argc, char **argv) {
  self = argv[0];
  if (argc > 1) return child(argc, argv);
  setvbuf(stdout, 0, _IONBF, 0);

  /* file actions: the child's stdout is a file opened for it */
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, 1, "/tmp/wali-proc.out", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  int status = run((char *[]){ (char *)self, "write", 0 }, &actions, 0);
  posix_spawn_file_actions_destroy(&actions);
  char text[64] = {0};
  int file = open("/tmp/wali-proc.out", O_RDONLY);
  read(file, text, sizeof text - 1);
  close(file);
  printf("addopen: exit=%d wrote=%s", WIFEXITED(status) ? WEXITSTATUS(status) : -1, text);

  /* a pipe: the child's stdout is the write end, and the read end is closed in it */
  int pipefd[2];
  pipe(pipefd);
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, pipefd[1], 1);
  posix_spawn_file_actions_addclose(&actions, pipefd[0]);
  pid_t pid;
  posix_spawn(&pid, self, &actions, 0, (char *[]){ (char *)self, "write", 0 }, environ);
  posix_spawn_file_actions_destroy(&actions);
  close(pipefd[1]);
  memset(text, 0, sizeof text);
  int got = 0, n;
  while ((n = read(pipefd[0], text + got, sizeof text - 1 - got)) > 0) got += n;
  close(pipefd[0]);
  waitpid(pid, &status, 0);
  printf("pipe: %s", text);

  /* close-on-exec: of two descriptors, the child gets the plain one */
  int plain = open("/tmp/wali-proc.out", O_RDONLY);
  int cloexec = open("/tmp/wali-proc.out", O_RDONLY | O_CLOEXEC);
  char a[16], b[16];
  snprintf(a, sizeof a, "%d", plain);
  snprintf(b, sizeof b, "%d", cloexec);
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, 1, "/tmp/wali-proc.fds", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  run((char *[]){ (char *)self, "fds", a, b, 0 }, &actions, 0);
  posix_spawn_file_actions_destroy(&actions);
  memset(text, 0, sizeof text);
  file = open("/tmp/wali-proc.fds", O_RDONLY);
  read(file, text, sizeof text - 1);
  close(file);
  printf("cloexec: %s", strcmp(text, "") ? (strstr(text, "=open") && strstr(text, "=closed") ? "plain open, cloexec closed\n" : text) : "nothing\n");
  close(plain);
  close(cloexec);

  /* the same across execve */
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, 1, "/tmp/wali-proc.fds", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  status = run((char *[]){ (char *)self, "exec", 0 }, &actions, 0);
  posix_spawn_file_actions_destroy(&actions);
  memset(text, 0, sizeof text);
  file = open("/tmp/wali-proc.fds", O_RDONLY);
  read(file, text, sizeof text - 1);
  close(file);
  printf("execve: exit=%d %s", WEXITSTATUS(status), strstr(text, "=open") && strstr(text, "=closed") ? "plain open, cloexec closed\n" : text);

  /* WNOHANG while the child runs, then the wait */
  posix_spawn(&pid, self, 0, 0, (char *[]){ (char *)self, "slow", 0 }, environ);
  int early = waitpid(pid, &status, WNOHANG);
  int late = waitpid(pid, &status, 0);
  printf("wnohang: %d then %s, exit=%d\n", early, late == pid ? "pid" : "other", WEXITSTATUS(status));

  /* a child killed by a signal */
  status = run((char *[]){ (char *)self, "term", 0 }, 0, 0);
  printf("signaled: %d sig=%d\n", WIFSIGNALED(status), WIFSIGNALED(status) ? WTERMSIG(status) : 0);

  /* posix_spawnp searches PATH; a missing program is ENOENT */
  char dir[256];
  strcpy(dir, self);
  *strrchr(dir, '/') = 0;
  setenv("PATH", dir, 1);
  int found = posix_spawnp(&pid, strrchr(self, '/') + 1, 0, 0, (char *[]){ (char *)self, "slow", 0 }, environ);
  if (!found) waitpid(pid, &status, 0);
  printf("spawnp: %d exit=%d missing=%s\n", found, WEXITSTATUS(status), strerror(posix_spawn(&pid, "/tmp/wali-proc-nothing", 0, 0, (char *[]){ "x", 0 }, environ)));

  /* system() and popen() run the shell */
  setenv("PATH", "/bin:/usr/bin", 1);
  status = system("exit 5");
  FILE *shell = popen("echo through the shell", "r");
  memset(text, 0, sizeof text);
  fgets(text, sizeof text, shell);
  int closed = pclose(shell);
  printf("system: exit=%d popen: %s pclose=%d\n", WEXITSTATUS(status), strtok(text, "\n"), WEXITSTATUS(closed));

  /* handlers: raise runs one before it returns; a blocked signal waits; an ignored one does nothing */
  signal(SIGUSR1, on_usr1);
  raise(SIGUSR1);
  int direct = usr1;
  sigset_t set, waiting;
  sigemptyset(&set);
  sigaddset(&set, SIGUSR1);
  sigprocmask(SIG_BLOCK, &set, 0);
  kill(getpid(), SIGUSR1);
  sigpending(&waiting);
  int held = usr1;
  sigprocmask(SIG_UNBLOCK, &set, 0);
  signal(SIGUSR2, SIG_IGN);
  raise(SIGUSR2);
  printf("raise: %d blocked: %d pending=%d unblocked: %d ignored usr2: alive\n", direct, held, sigismember(&waiting, SIGUSR1), usr1);

  /* a child inherits the ignored signals and the mask */
  sigprocmask(SIG_BLOCK, &set, 0);
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, 1, "/tmp/wali-proc.sig", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  status = run((char *[]){ (char *)self, "signals", 0 }, &actions, 0);
  posix_spawn_file_actions_destroy(&actions);
  sigprocmask(SIG_UNBLOCK, &set, 0);
  memset(text, 0, sizeof text);
  file = open("/tmp/wali-proc.sig", O_RDONLY);
  read(file, text, sizeof text - 1);
  close(file);
  printf("inherited: exit=%d %s", WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status), text);

  /* SIGCHLD reaches its handler, and the wait still returns the child */
  signal(SIGCHLD, on_chld);
  posix_spawn(&pid, self, 0, 0, (char *[]){ (char *)self, "slow", 0 }, environ);
  late = waitpid(pid, &status, 0);
  printf("sigchld: %d wait=%s\n", chld > 0, late == pid ? "pid" : strerror(errno));

  /* a sleep cut short by SIGALRM, and pause */
  signal(SIGALRM, on_alrm);
  alarm(1);
  unsigned left = sleep(5);
  alarm(1);
  pause();
  printf("alarm: handled=%d sleep left %u of 5, pause returned\n", alrm, left);
  return 0;
}
