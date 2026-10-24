/*
 * POSIX record locks between a process and its forked children: a lock keeps another process out of its range (and
 * F_GETLK says whose it is), F_SETLKW waits for it, a close of any descriptor for the file gives the locks up, and so
 * does the end of the process; two processes waiting on each other's are told of the circle.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int range(int fd, int cmd, short type, off_t start, off_t length)
{
  struct flock lock = { .l_type = type, .l_whence = SEEK_SET, .l_start = start, .l_len = length };
  return fcntl(fd, cmd, &lock);
}

static int status_of(pid_t pid)
{
  int status;
  waitpid(pid, &status, 0);
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static void pause_ms(int ms)
{
  struct timespec wait = { 0, ms * 1000000L };
  nanosleep(&wait, 0);
}

int main(void)
{
  char path[] = "/tmp/wali-locksXXXXXX";
  int fd = mkstemp(path);
  ftruncate(fd, 100);

  /* what a lock keeps out, and what F_GETLK says */
  range(fd, F_SETLK, F_WRLCK, 0, 10);
  pid_t parent = getpid();
  pid_t child = fork();
  if (child == 0) {
    int file = open(path, O_RDWR);
    struct flock probe = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 5, .l_len = 1 };
    fcntl(file, F_GETLK, &probe);
    int held = probe.l_type == F_WRLCK && probe.l_pid == parent && probe.l_start == 0 && probe.l_len == 10;
    int refused = range(file, F_SETLK, F_WRLCK, 5, 1) == -1 && errno == EAGAIN;
    int free_range = range(file, F_SETLK, F_WRLCK, 20, 10) == 0;
    probe = (struct flock){ .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 40, .l_len = 1 };
    fcntl(file, F_GETLK, &probe);
    _exit(held | refused << 1 | free_range << 2 | (probe.l_type == F_UNLCK) << 3);
  }
  printf("conflict=%d\n", status_of(child));

  /* read locks share, a write lock does not */
  range(fd, F_SETLK, F_UNLCK, 0, 0);
  range(fd, F_SETLK, F_RDLCK, 0, 10);
  child = fork();
  if (child == 0) {
    int file = open(path, O_RDWR);
    int shared = range(file, F_SETLK, F_RDLCK, 0, 10) == 0;
    int exclusive = range(file, F_SETLK, F_WRLCK, 0, 10) == 0;
    _exit(shared | exclusive << 1);
  }
  printf("shared=%d\n", status_of(child));
  range(fd, F_SETLK, F_UNLCK, 0, 0);

  /* two ranges next to each other, and a hole cut in them */
  range(fd, F_SETLK, F_WRLCK, 0, 10);
  range(fd, F_SETLK, F_WRLCK, 10, 10);
  range(fd, F_SETLK, F_UNLCK, 5, 10);
  child = fork();
  if (child == 0) {
    int file = open(path, O_RDWR);
    int before = range(file, F_SETLK, F_WRLCK, 4, 1) == -1;
    int hole = range(file, F_SETLK, F_WRLCK, 7, 1) == 0;
    int after = range(file, F_SETLK, F_WRLCK, 15, 1) == -1;
    _exit(before | hole << 1 | after << 2);
  }
  printf("hole=%d\n", status_of(child));
  range(fd, F_SETLK, F_UNLCK, 0, 0);

  /* F_SETLKW waits until the range is given up */
  range(fd, F_SETLK, F_WRLCK, 0, 10);
  child = fork();
  if (child == 0) {
    int file = open(path, O_RDWR);
    _exit(range(file, F_SETLKW, F_WRLCK, 0, 10));
  }
  pause_ms(300);
  int running = waitpid(child, 0, WNOHANG) == 0;
  range(fd, F_SETLK, F_UNLCK, 0, 10);
  printf("wait=%d waited=%d\n", status_of(child), running);

  /* a close of any descriptor for the file gives the locks up */
  range(fd, F_SETLK, F_WRLCK, 0, 10);
  close(open(path, O_RDONLY));
  child = fork();
  if (child == 0) {
    int file = open(path, O_RDWR);
    _exit(range(file, F_SETLK, F_WRLCK, 0, 10) == 0);
  }
  printf("closed=%d\n", status_of(child));

  /* the end of the process does too */
  child = fork();
  if (child == 0) {
    int file = open(path, O_RDWR);
    range(file, F_SETLK, F_WRLCK, 50, 10);
    _exit(0);
  }
  status_of(child);
  printf("exited=%d\n", range(fd, F_SETLK, F_WRLCK, 50, 10) == 0);

  /* each holds a byte the other waits for */
  range(fd, F_SETLK, F_UNLCK, 0, 0);
  range(fd, F_SETLK, F_WRLCK, 0, 1);
  int sync[2];
  pipe(sync);
  child = fork();
  if (child == 0) {
    int file = open(path, O_RDWR);
    range(file, F_SETLK, F_WRLCK, 1, 1);
    write(sync[1], "x", 1);
    _exit(range(file, F_SETLKW, F_WRLCK, 0, 1));
  }
  char byte;
  read(sync[0], &byte, 1);
  pause_ms(300);
  int circle = range(fd, F_SETLKW, F_WRLCK, 1, 1) == -1 && errno == EDEADLK;
  range(fd, F_SETLK, F_UNLCK, 0, 0);
  printf("deadlock=%d child=%d\n", circle, status_of(child));
  unlink(path);
  return 0;
}
