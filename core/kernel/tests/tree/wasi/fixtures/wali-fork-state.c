/*
 * fork on WALI, the host's own state in the child: how far a directory was read, an epoll interest list, a shared file
 * mapping (the two processes see each other's writes, as on Linux) and the alternate signal stack.
 */
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static int wait_for(pid_t pid)
{
  int status;
  waitpid(pid, &status, 0);
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static void directory(void)
{
  mkdir("/tmp/wali-fork-dir", 0755);
  for (int i = 0; i < 6; i++) {
    char path[64];
    snprintf(path, sizeof path, "/tmp/wali-fork-dir/f%d", i);
    close(open(path, O_CREAT | O_WRONLY, 0644));
  }
  DIR *dir = opendir("/tmp/wali-fork-dir");
  int before = 0;
  while (before < 3 && readdir(dir)) before++;
  int fds[2];
  pipe(fds);
  pid_t pid = fork();
  if (pid == 0) {
    int rest = 0;
    while (readdir(dir)) rest++;
    write(fds[1], &rest, sizeof rest);
    _exit(0);
  }
  int rest = -1;
  read(fds[0], &rest, sizeof rest);
  wait_for(pid);
  /* the listing is the six files (the kernel gives no dot entries): three read before the fork, three left */
  printf("dir before=%d child-rest=%d\n", before, rest);
}

static void epolled(void)
{
  int fds[2];
  pipe(fds);
  int ep = epoll_create1(0);
  struct epoll_event event = { .events = EPOLLIN, .data.u64 = 0x1234567890abcdefULL };
  epoll_ctl(ep, EPOLL_CTL_ADD, fds[0], &event);
  pid_t pid = fork();
  if (pid == 0) {
    write(fds[1], "x", 1);
    struct epoll_event got;
    int count = epoll_wait(ep, &got, 1, 5000);
    _exit(count == 1 && got.data.u64 == 0x1234567890abcdefULL ? 0 : 1);
  }
  printf("epoll child=%d\n", wait_for(pid));
}

static void shared(void)
{
  int file = open("/tmp/wali-fork-map", O_RDWR | O_CREAT | O_TRUNC, 0644);
  ftruncate(file, 4096);
  char *map = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, file, 0);
  strcpy(map, "before");
  int up[2], down[2];
  pipe(up);
  pipe(down);
  pid_t pid = fork();
  if (pid == 0) {
    char seen[16] = { 0 };
    /* what the parent wrote before the fork is there, and what it writes after, once it says so */
    int fresh = !strcmp(map, "before");
    strcpy(map + 64, "from-child");
    write(up[1], "1", 1);
    char go;
    read(down[0], &go, 1);
    snprintf(seen, sizeof seen, "%s", map + 128);
    _exit(fresh && !strcmp(seen, "from-parent") ? 0 : 1);
  }
  char go;
  read(up[0], &go, 1);
  int child_wrote = !strcmp(map + 64, "from-child");
  strcpy(map + 128, "from-parent");
  write(down[1], "1", 1);
  int status = wait_for(pid);
  /* msync has the child's write, as the parent's own table of mappings, and a fresh read of the file, see it */
  printf("shared child=%d parent-saw=%d\n", status, child_wrote);
  munmap(map, 4096);
}

static volatile int on_alt;
static char stack[16384];
static void handler(int signal)
{
  char marker;
  on_alt = (char *)&marker >= stack && (char *)&marker < stack + sizeof stack;
}

static void altstack(void)
{
  stack_t alt = { .ss_sp = stack, .ss_size = sizeof stack };
  sigaltstack(&alt, 0);
  struct sigaction action = { .sa_handler = handler, .sa_flags = SA_ONSTACK };
  sigaction(SIGUSR1, &action, 0);
  pid_t pid = fork();
  if (pid == 0) {
    raise(SIGUSR1);
    _exit(on_alt ? 0 : 1);
  }
  printf("altstack child=%d\n", wait_for(pid));
}

int main(void)
{
  directory();
  epolled();
  shared();
  altstack();
  return 0;
}
