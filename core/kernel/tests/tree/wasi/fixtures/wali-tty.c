/* Terminals and job control on WALI's musl: a pty and its settings, stopping and continuing, and a background read of
 * the controlling terminal. The program starts copies of itself in the roles named by argv[1]; with no role it runs
 * the checks and prints what it found. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

extern char **environ;
static const char *self;
static volatile sig_atomic_t continued;

static void on_cont(int signal) { (void)signal; continued++; }

static pid_t start(char *const argv[], posix_spawn_file_actions_t *actions, posix_spawnattr_t *attr) {
  pid_t pid;
  return posix_spawn(&pid, self, actions, attr, argv, environ) ? -1 : pid;
}

/* reads what the master has, waiting a little for it */
static int drain(int master, char *into, int room) {
  usleep(20000);
  int n = read(master, into, room - 1);
  into[n > 0 ? n : 0] = 0;
  return n;
}

/* a session of its own on the terminal named, in front of it, with a child in a group of its own that reads it */
static int session(const char *tty, const char *role) {
  setsid();
  int fd = open(tty, O_RDWR);
  ioctl(fd, TIOCSCTTY, 0);
  tcsetpgrp(fd, getpid());
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, fd, 0);
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP);
  posix_spawnattr_setpgroup(&attr, 0);
  pid_t pid = start((char *[]){ (char *)self, (char *)role, 0 }, &actions, &attr);
  int status;
  waitpid(pid, &status, WUNTRACED);
  if (WIFSTOPPED(status)) {
    printf("background read: stopped by %s, foreground=%d\n", WSTOPSIG(status) == SIGTTIN ? "SIGTTIN" : strsignal(WSTOPSIG(status)), tcgetpgrp(fd) == getpid());
    kill(pid, SIGKILL);
    waitpid(pid, &status, 0);
  } else {
    printf("background read: exit=%d\n", WEXITSTATUS(status));
  }
  return 0;
}

static int child(int argc, char **argv) {
  const char *role = argv[1];
  if (!strcmp(role, "tstp")) {                      /* stops itself, then says whether its handler saw SIGCONT */
    signal(SIGCONT, on_cont);
    raise(SIGTSTP);
    printf("child continued, handler=%d\n", continued);
    return 0;
  }
  if (!strcmp(role, "spin")) {                      /* sleeps a while in small steps */
    for (int i = 0; i < 30; i++) usleep(10000);
    return 4;
  }
  if (!strcmp(role, "session") && argc > 3) return session(argv[2], argv[3]);
  if (!strcmp(role, "bgread")) {                    /* reads the terminal from the background */
    char c;
    read(0, &c, 1);
    return 0;
  }
  if (!strcmp(role, "bgread-ignored")) {            /* the same, with SIGTTIN ignored: EIO */
    signal(SIGTTIN, SIG_IGN);
    char c;
    int n = read(0, &c, 1);
    printf("ignored SIGTTIN: read=%d %s\n", n, errno == EIO ? "EIO" : strerror(errno));
    return 5;
  }
  return 100;
}

int main(int argc, char **argv) {
  self = argv[0];
  if (argc > 1) return child(argc, argv);
  setvbuf(stdout, 0, _IONBF, 0);

  /* a pty: its slave's name, its settings and window size */
  int master = posix_openpt(O_RDWR | O_NOCTTY);
  int granted = grantpt(master), unlocked = unlockpt(master);
  const char *name = ptsname(master);
  int slave = open(name, O_RDWR | O_NOCTTY);
  printf("pty: grant=%d unlock=%d name=%s tty=%d\n", granted, unlocked, strncmp(name, "/dev/pts/", 9) ? name : "/dev/pts/N", isatty(slave));
  struct winsize size = { .ws_row = 30, .ws_col = 100 }, got = {0};
  ioctl(master, TIOCSWINSZ, &size);
  ioctl(slave, TIOCGWINSZ, &got);
  printf("winsize: %dx%d\n", got.ws_row, got.ws_col);

  /* output: a newline becomes CR LF when cooked, and stays as it is raw */
  char text[64];
  write(slave, "x\n", 2);
  drain(master, text, sizeof text);
  int cooked = !strcmp(text, "x\r\n");
  struct termios mode;
  tcgetattr(slave, &mode);
  cfmakeraw(&mode);
  tcsetattr(slave, TCSANOW, &mode);
  tcgetattr(slave, &mode);
  write(slave, "y\n", 2);
  drain(master, text, sizeof text);
  printf("output: cooked crlf=%d raw lf=%d icanon=%d\n", cooked, !strcmp(text, "y\n"), (mode.c_lflag & ICANON) != 0);

  /* input: raw, a byte is there to read as soon as it is typed */
  write(master, "k", 1);
  usleep(20000);
  char key = 0;
  int typed = read(slave, &key, 1);
  printf("input: read=%d key=%c\n", typed, key);

  /* a child stops itself with SIGTSTP and is continued: its SIGCONT handler runs */
  pid_t pid = start((char *[]){ (char *)self, "tstp", 0 }, 0, 0);
  int status;
  waitpid(pid, &status, WUNTRACED);
  printf("tstp: stopped=%d sig=%d\n", WIFSTOPPED(status), WIFSTOPPED(status) ? WSTOPSIG(status) : 0);
  kill(pid, SIGCONT);
  waitpid(pid, &status, 0);
  printf("tstp: exit=%d\n", WEXITSTATUS(status));

  /* stopped from outside by SIGSTOP, then continued */
  pid = start((char *[]){ (char *)self, "spin", 0 }, 0, 0);
  usleep(50000);
  kill(pid, SIGSTOP);
  waitpid(pid, &status, WUNTRACED);
  int stopped = WIFSTOPPED(status), sig = WIFSTOPPED(status) ? WSTOPSIG(status) : 0;
  kill(pid, SIGCONT);
  waitpid(pid, &status, 0);
  printf("sigstop: stopped=%d sig=%d exit=%d\n", stopped, sig, WEXITSTATUS(status));

  /* reading the controlling terminal from the background: SIGTTIN, or EIO when it is ignored */
  close(slave);
  for (const char *role = "bgread"; role; role = strcmp(role, "bgread") ? 0 : "bgread-ignored") {
    pid = start((char *[]){ (char *)self, "session", (char *)name, (char *)role, 0 }, 0, 0);
    waitpid(pid, &status, 0);
  }
  return 0;
}
