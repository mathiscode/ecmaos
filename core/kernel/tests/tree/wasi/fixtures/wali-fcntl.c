/* fcntl's third argument as musl hands it on: read as an `unsigned long` (8 bytes on this target) where the caller
 * passed an int or a pointer (4 bytes), so its upper half is whatever lay beyond on the stack. syscall() passes a
 * whole long, so the upper half here is set on purpose; only the lower may count. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

#define HIGH (1L << 32)

int main(void) {
  int fd = open("/tmp/wali-fcntl.txt", O_RDWR | O_CREAT | O_TRUNC, 0644);
  int copy = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  printf("dupfd: above=%d cloexec=%d\n", copy > fd, (fcntl(copy, F_GETFD) & FD_CLOEXEC) != 0);

  long at = syscall(SYS_fcntl, fd, F_DUPFD_CLOEXEC, HIGH | 40);
  printf("upper half set: dupfd=%ld\n", at);
  struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET };
  long got = syscall(SYS_fcntl, fd, F_GETLK, HIGH | (long)(uintptr_t)&lock);
  printf("upper half set: getlk=%ld unlocked=%d\n", got, lock.l_type == F_UNLCK);

  struct rlimit limit;
  getrlimit(RLIMIT_NOFILE, &limit);
  printf("at the limit: %s\n", fcntl(fd, F_DUPFD, (int)limit.rlim_cur) < 0 ? strerror(errno) : "made");
  printf("negative: %s\n", fcntl(fd, F_DUPFD, -1) < 0 ? strerror(errno) : "made");
  return 0;
}
