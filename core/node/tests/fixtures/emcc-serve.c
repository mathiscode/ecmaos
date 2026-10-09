/* serve PORT [N]: listens on 127.0.0.1:PORT, accepts N connections (default 1), and for each reads until the peer ends,
 * sending the bytes back upper-cased plus "|BYE". Prints "listening" once it is ready. Exit 3 when a call fails. */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>
#include <ctype.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
  if (argc < 2) return 1;
  int served = argc > 2 ? atoi(argv[2]) : 1;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { printf("socket: errno %d\n", errno); return 3; }
  struct sockaddr_in at;
  memset(&at, 0, sizeof at);
  at.sin_family = AF_INET;
  at.sin_port = htons(atoi(argv[1]));
  inet_pton(AF_INET, "127.0.0.1", &at.sin_addr);
  if (bind(fd, (struct sockaddr *)&at, sizeof at) < 0) { printf("bind: errno %d\n", errno); return 3; }
  if (listen(fd, 4) < 0) { printf("listen: errno %d\n", errno); return 3; }
  printf("listening\n");
  fflush(stdout);
  for (int i = 0; i < served; i++) {
    int c = accept(fd, NULL, NULL);
    if (c < 0) { printf("accept: errno %d\n", errno); return 3; }
    char buf[1024];
    ssize_t n;
    while ((n = read(c, buf, sizeof buf)) > 0) {
      for (ssize_t k = 0; k < n; k++) buf[k] = toupper((unsigned char)buf[k]);
      write(c, buf, n);
    }
    write(c, "|BYE", 4);
    close(c);
  }
  return 0;
}
