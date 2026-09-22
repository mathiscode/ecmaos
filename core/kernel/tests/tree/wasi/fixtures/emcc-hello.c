#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <string.h>

int main(int argc, char **argv) {
  printf("hello from emscripten\n");
  int fd = open("/tmp/emtest-out.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  write(fd, "wrote this\n", 11);
  close(fd);

  struct stat st;
  stat("/tmp/emtest-out.txt", &st);
  printf("size=%ld\n", (long)st.st_size);

  mkdir("/tmp/emtest-dir", 0755);
  return 3;
}
