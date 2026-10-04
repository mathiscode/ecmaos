/* readdir must see every entry exactly once and then the end of the directory, however many getdents calls it takes. */
#include <stdio.h>
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

int main(void) {
  mkdir("/tmp/emcc-readdir", 0755);
  char path[64];
  for (int i = 0; i < 300; i++) {
    snprintf(path, sizeof path, "/tmp/emcc-readdir/entry-with-a-longish-name-%03d", i);
    close(open(path, O_CREAT | O_WRONLY, 0644));
  }
  int count = 0;
  if (!opendir("/tmp/emcc-readdir")) { printf("opendir failed %d\n", errno); return 1; }
  DIR *dir = opendir("/tmp/emcc-readdir");
  while (readdir(dir)) count++;
  rewinddir(dir);
  int again = 0;
  while (readdir(dir)) again++;
  closedir(dir);
  printf("entries=%d rewound=%d\n", count, again);
  return 0;
}
