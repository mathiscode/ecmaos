/*
 * fork on WALI: built with Asyncify (wali.build.sh), so the call returns twice. The child inherits the locals, the
 * memory and the descriptors (the pipe is the parent's, and the file's offset is shared), and has its own pid.
 */
#include <fcntl.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int nested(int depth)
{
  if (depth) return nested(depth - 1) + 1;
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) _exit(40);
  int status;
  waitpid(pid, &status, 0);
  return WEXITSTATUS(status);
}

/* the child leaves by longjmp, into the frame that was rewound */
static int through_setjmp(void)
{
  jmp_buf env;
  volatile int step = 0;
  if (setjmp(env)) _exit(step + 50);
  pid_t pid = fork();
  if (pid == 0) {
    step = 3;
    longjmp(env, 1);
  }
  int status;
  waitpid(pid, &status, 0);
  return WEXITSTATUS(status);
}

int main(void)
{
  int fds[2], local = 7;
  char heap[16];
  strcpy(heap, "heap");
  if (pipe(fds)) return 1;
  int file = open("/tmp/wali-fork.txt", O_RDWR | O_CREAT | O_TRUNC, 0644);
  printf("start\n");
  fflush(stdout);

  pid_t pid = fork();
  if (pid < 0) { printf("fork failed\n"); return 2; }
  if (pid == 0) {
    close(fds[0]);
    local++;
    char text[96];
    int length = snprintf(text, sizeof text, "child local=%d heap=%s differs=%d ", local, heap, getpid() != getppid());
    write(fds[1], text, length);
    write(file, "child;", 6);
    _exit(5);
  }

  close(fds[1]);
  char buffer[128] = { 0 };
  read(fds[0], buffer, sizeof buffer - 1);
  int status;
  waitpid(pid, &status, 0);
  write(file, "parent;", 7);
  char contents[32] = { 0 };
  pread(file, contents, sizeof contents - 1, 0);
  printf("%sexit=%d signaled=%d pid-ok=%d local=%d\n", buffer, WEXITSTATUS(status), WIFSIGNALED(status), pid > 0 && pid != getpid(), local);
  printf("file=%s\n", contents);
  printf("nested=%d\n", nested(3));
  printf("setjmp=%d\n", through_setjmp());
  return 0;
}
