/* udpserve PORT [N]: binds a UDP socket to 127.0.0.1:PORT, and for each of N datagrams (default 1) replies to whoever sent it
 * with the datagram upper-cased, "|" and the sender's address. Prints "listening" once bound. Exit 3 when a call fails. */
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
  int count = argc > 2 ? atoi(argv[2]) : 1;
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) { printf("socket: errno %d\n", errno); return 3; }
  struct sockaddr_in at;
  memset(&at, 0, sizeof at);
  at.sin_family = AF_INET;
  at.sin_port = htons(atoi(argv[1]));
  inet_pton(AF_INET, "127.0.0.1", &at.sin_addr);
  if (bind(fd, (struct sockaddr *)&at, sizeof at) < 0) { printf("bind: errno %d\n", errno); return 3; }
  printf("listening\n");
  fflush(stdout);
  for (int i = 0; i < count; i++) {
    char buf[1024];
    struct sockaddr_in from;
    socklen_t length = sizeof from;
    ssize_t n = recvfrom(fd, buf, sizeof buf - 64, 0, (struct sockaddr *)&from, &length);
    if (n < 0) { printf("recvfrom: errno %d\n", errno); return 3; }
    for (ssize_t k = 0; k < n; k++) buf[k] = toupper((unsigned char)buf[k]);
    n += sprintf(buf + n, "|%s", inet_ntoa(from.sin_addr));
    if (sendto(fd, buf, n, 0, (struct sockaddr *)&from, length) < 0) { printf("sendto: errno %d\n", errno); return 3; }
  }
  return 0;
}
