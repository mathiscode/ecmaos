/* Failed calls must set errno to the numbers this toolchain compiles ENOENT and friends to. */
#include <stdio.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

int main(void) {
  struct stat st;
  int stat_missing = stat("/tmp/emcc-errno-missing", &st) == -1 && errno == ENOENT;
  int open_missing = open("/tmp/emcc-errno-missing", O_RDONLY) == -1 && errno == ENOENT;
  int rmdir_missing = rmdir("/tmp/emcc-errno-missing") == -1 && errno == ENOENT;
  int open_dir_for_write = open("/tmp", O_WRONLY) == -1 && errno == EISDIR;
  printf("stat=%d open=%d rmdir=%d dir=%d\n", stat_missing, open_missing, rmdir_missing, open_dir_for_write);
  return 0;
}
