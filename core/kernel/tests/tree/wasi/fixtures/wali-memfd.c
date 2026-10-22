/* memfd_create and fallocate on WALI's musl, as a Wayland client sizes a wl_shm pool (SDL does both): the file has no
 * name, posix_fallocate grows it, it maps shared, and its descriptor goes to a child that reads what was written. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
  setvbuf(stdout, 0, _IONBF, 0);
  if (argc > 1) {
    /* the child: the descriptor it was given */
    char text[32] = {0};
    pread(5, text, sizeof text - 1, 4096);
    printf("child: %s\n", text);
    return 0;
  }
  int fd = memfd_create("pool", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  struct stat st;
  fstat(fd, &st);
  printf("memfd: fd>=0=%d cloexec=%d size=%lld\n", fd >= 0, (fcntl(fd, F_GETFD) & FD_CLOEXEC) != 0, (long long)st.st_size);
  printf("bad flags: %s\n", memfd_create("x", 0x100) < 0 ? strerror(errno) : "made");

  int grow = posix_fallocate(fd, 0, 8192);
  fstat(fd, &st);
  printf("fallocate: %d size=%lld\n", grow, (long long)st.st_size);
  int keep = fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, 65536);
  fstat(fd, &st);
  printf("keep size: %d size=%lld\n", keep, (long long)st.st_size);
  int shorter = posix_fallocate(fd, 0, 100);
  fstat(fd, &st);
  printf("within: %d size=%lld\n", shorter, (long long)st.st_size);
  printf("punch: %s\n", fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 0, 4096) < 0 ? strerror(errno) : "done");
  int fds[2];
  pipe(fds);
  printf("pipe: %s\n", strerror(posix_fallocate(fds[1], 0, 10)));

  char *p = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  strcpy(p + 4096, "through the mapping");
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, fd, 5);
  pid_t pid;
  char *args[] = { argv[0], "child", 0 };
  posix_spawn(&pid, argv[0], &actions, 0, args, environ);
  int status;
  waitpid(pid, &status, 0);
  printf("exit=%d\n", WEXITSTATUS(status));
  return 0;
}
