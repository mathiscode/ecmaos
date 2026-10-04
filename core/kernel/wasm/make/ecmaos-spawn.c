/*
 * What GNU make needs from a process model that has no fork: every recipe line runs to completion inside
 * `ecmaos_run` (through system(3), which the wasm shim answers with `/bin/ecmash -c` as a child holding the terminal),
 * and `waitpid` hands back the status it stored. So make runs one job at a time, as with `-j1`.
 * `$(shell ...)` wants a pipe: `pipe` here is a temporary file, which is enough because the command has finished
 * before make reads from it, and `ecmaos_run` appends the child's output to that file with a shell redirection.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAXPIPES 64
static struct { int wfd; char path[64]; } pipes[MAXPIPES];
static int npipes;
static pid_t next_pid = 1000;
static struct { pid_t pid; int status; } done[256];
static int ndone;

int pipe(int fds[2]) {
  if (npipes == MAXPIPES) { errno = EMFILE; return -1; }
  snprintf(pipes[npipes].path, sizeof pipes[npipes].path, "/tmp/.make-pipe-%d-%d", (int) getpid(), npipes);
  fds[1] = open(pipes[npipes].path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  fds[0] = open(pipes[npipes].path, O_RDONLY);
  if (fds[0] < 0 || fds[1] < 0) return -1;
  pipes[npipes].wfd = fds[1];
  npipes++;
  return 0;
}

static void quote(char **out, size_t *len, size_t *cap, const char *s) {
  size_t need = strlen(s) * 4 + 4;
  if (*len + need >= *cap) { *cap = (*cap + need) * 2; *out = realloc(*out, *cap); }
  (*out)[(*len)++] = '\'';
  for (; *s; s++) {
    if (*s == '\'') { memcpy(*out + *len, "'\\''", 4); *len += 4; } else (*out)[(*len)++] = *s;
  }
  (*out)[(*len)++] = '\'';
  (*out)[(*len)++] = ' ';
}

pid_t ecmaos_run(char **argv, int fdout) {
  size_t len = 0, cap = 256;
  char *cmd = malloc(cap);
  const char *target = NULL;
  for (int i = 0; i < npipes; i++) if (pipes[i].wfd == fdout) target = pipes[i].path;
  for (char **a = argv; *a; a++) quote(&cmd, &len, &cap, *a);
  cmd[len] = 0;
  if (target) {
    char *wrapped = malloc(len + strlen(target) + 32);
    sprintf(wrapped, "{ %s; } >> '%s'", cmd, target);
    free(cmd);
    cmd = wrapped;
  }
  fflush(NULL);
  int status = system(cmd);
  free(cmd);
  if (status == -1) { errno = ENOEXEC; return -1; }
  if (ndone == 256) { errno = EAGAIN; return -1; }
  done[ndone].pid = ++next_pid;
  done[ndone].status = status;
  return done[ndone++].pid;
}

pid_t waitpid(pid_t pid, int *status, int options) {
  for (int i = 0; i < ndone; i++) {
    if (pid > 0 && done[i].pid != pid) continue;
    pid_t got = done[i].pid;
    if (status) *status = done[i].status;
    memmove(&done[i], &done[i + 1], (ndone - i - 1) * sizeof done[0]);
    ndone--;
    return got;
  }
  (void) options;
  errno = ECHILD;
  return -1;
}
pid_t wait(int *status) { return waitpid(-1, status, 0); }
pid_t wait3(int *status, int options, struct rusage *usage) { (void) usage; return waitpid(-1, status, options); }
