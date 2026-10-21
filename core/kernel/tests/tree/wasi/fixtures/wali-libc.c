/* The C library on WALI's musl, against ecmaOS's host (src/bin/wali-host.mjs): what each line prints is checked. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  printf("argc=%d argv1=%s env=%s\n", argc, argc > 1 ? argv[1] : "-", getenv("WALI_FIXTURE") ? getenv("WALI_FIXTURE") : "-");

  /* errno is Linux's numbering: the program was compiled with ENOENT = 2 */
  struct stat st;
  printf("enoent=%d\n", stat("/tmp/wali-missing", &st) == -1 && errno == ENOENT && ENOENT == 2);

  /* *at calls relative to a directory descriptor, and fstat through AT_EMPTY_PATH */
  mkdir("/tmp/wali-dir", 0755);
  int dir = open("/tmp/wali-dir", O_RDONLY | O_DIRECTORY);
  int file = openat(dir, "made.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  write(file, "mapped text\n", 12);
  close(file);
  printf("fstatat=%d size=%lld\n", fstatat(dir, "made.txt", &st, 0), (long long)st.st_size);
  printf("empty_path=%d dir=%d\n", fstatat(dir, "", &st, AT_EMPTY_PATH), S_ISDIR(st.st_mode));
  printf("mkdirat=%d unlinkat=%d\n", mkdirat(dir, "sub", 0755), unlinkat(dir, "sub", AT_REMOVEDIR));

  /* a directory read to its end, then again after rewinddir */
  for (int i = 0; i < 40; i++) {
    char name[32];
    snprintf(name, sizeof name, "f%02d", i);
    close(openat(dir, name, O_WRONLY | O_CREAT, 0644));
  }
  DIR *listing = opendir("/tmp/wali-dir");
  int first = 0, second = 0;
  while (readdir(listing)) first++;
  rewinddir(listing);
  while (readdir(listing)) second++;
  closedir(listing);
  printf("readdir=%d again=%d\n", first, second);

  /* a private mapping of a file holds what the file does */
  file = open("/tmp/wali-dir/made.txt", O_RDONLY);
  char *map = mmap(0, 12, PROT_READ, MAP_PRIVATE, file, 0);
  printf("mmap=%.11s\n", map == MAP_FAILED ? "failed" : map);
  munmap(map, 12);

  /* descriptor flags the kernel does not keep */
  int fl = fcntl(file, F_GETFL);
  printf("getfl=%d cloexec=%d", (fl & O_ACCMODE) == O_RDONLY, fcntl(file, F_GETFD));
  fcntl(file, F_SETFD, FD_CLOEXEC);
  printf(" set=%d", fcntl(file, F_GETFD));
  int copy = dup3(file, 20, O_CLOEXEC);
  printf(" dup3=%d %d high=%d\n", copy, fcntl(copy, F_GETFD), fcntl(file, F_DUPFD, 30) >= 30);
  close(file);
  close(dir);

  /* mappings are given back and used again */
  void *blocks[8];
  for (int round = 0; round < 50; round++) {
    for (int i = 0; i < 8; i++) memset(blocks[i] = malloc(256 * 1024), round, 256 * 1024);
    for (int i = 0; i < 8; i++) free(blocks[i]);
  }
  printf("malloc ok\n");
  return 3;
}
