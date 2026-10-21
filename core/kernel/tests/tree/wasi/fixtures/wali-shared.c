/* Shared file mappings on WALI's musl across processes: a child started after the program wrote through its mapping
 * reads the change from the file, the program sees a child's write once it has waited for it, and what is left of a
 * mapping unmapped in part still reaches the file. The program starts copies of itself in the roles named by
 * argv[1]; with no role it runs the checks and prints what it found. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
#define PAGE 4096
#define FILE_PATH "/tmp/wali-shared.dat"

static int run(const char *self, const char *role) {
  pid_t pid;
  int status;
  if (posix_spawn(&pid, self, 0, 0, (char *[]){ (char *)self, (char *)role, 0 }, environ)) return -1;
  return waitpid(pid, &status, 0) == pid ? WEXITSTATUS(status) : -1;
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "read")) {    /* prints what the file holds at its start */
    char text[16] = {0};
    int fd = open(FILE_PATH, O_RDONLY);
    read(fd, text, 10);
    printf("child read: %s\n", text);
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "poke")) {    /* writes into the file's second page */
    int fd = open(FILE_PATH, O_WRONLY);
    pwrite(fd, "from child", 10, PAGE);
    return 0;
  }
  setvbuf(stdout, 0, _IONBF, 0);

  int fd = open(FILE_PATH, O_RDWR | O_CREAT | O_TRUNC, 0644);
  ftruncate(fd, 3 * PAGE);
  char *map = mmap(0, 3 * PAGE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);

  /* written through the pointer, with no msync: a child started next reads it from the file */
  memcpy(map, "from shell", 10);
  run(argv[0], "read");

  /* a child's write to the file is in the mapping once the program has waited for it */
  run(argv[0], "poke");
  printf("parent sees: %.10s\n", map + PAGE);

  /* the middle page unmapped: the third is still the file's */
  munmap(map + PAGE, PAGE);
  memcpy(map + 2 * PAGE, "third page", 10);
  munmap(map + 2 * PAGE, PAGE);
  char text[16] = {0};
  pread(fd, text, 10, 2 * PAGE);
  printf("after munmap: %s\n", text);

  /* a pipe cannot be mapped shared */
  int ends[2];
  pipe(ends);
  printf("pipe: %s\n", mmap(0, PAGE, PROT_READ, MAP_SHARED, ends[0], 0) == MAP_FAILED ? "refused" : "mapped");
  return 0;
}
