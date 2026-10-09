/* net6 serve tcp|udp PORT [N]: a dual-stack server on [::]:PORT that handles N clients (default 1). TCP: reads until the peer ends and sends
 * the bytes back upper-cased plus "|BYE". UDP: answers each datagram with the text upper-cased plus "|" and the sender's address. Prints
 * "listening" when ready and "peer ADDRESS" for each client (inet_ntop of the sockaddr_in6, so an IPv4 client shows mapped).
 * net6 connect HOST PORT: resolves HOST for AF_INET6 with AI_V4MAPPED (so a plain IPv4 address comes back mapped), connects, sends
 * "hello mapped", and prints the reply and the family it connected with. Exit 3 when a call fails (errno printed). */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>
#include <ctype.h>
#include <unistd.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
  if (argc >= 4 && !strcmp(argv[1], "connect")) {
    struct addrinfo hints, *res = 0;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_INET6;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_V4MAPPED;
    if (getaddrinfo(argv[2], argv[3], &hints, &res) || !res) { printf("getaddrinfo failed\n"); return 3; }
    int fd = socket(res->ai_family, SOCK_STREAM, 0);
    if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) { printf("connect: errno %d\n", errno); return 3; }
    write(fd, "hello mapped", 12);
    shutdown(fd, SHUT_WR);
    char buf[256];
    ssize_t n, total = 0;
    while ((n = read(fd, buf + total, sizeof buf - 1 - total)) > 0) total += n;
    buf[total] = 0;
    printf("reply %s family=%d\n", buf, res->ai_family);
    return 0;
  }
  if (argc < 4 || strcmp(argv[1], "serve")) return 1;
  int udp = !strcmp(argv[2], "udp");
  int port = atoi(argv[3]);
  int served = argc > 4 ? atoi(argv[4]) : 1;
  int fd = socket(AF_INET6, udp ? SOCK_DGRAM : SOCK_STREAM, 0);
  if (fd < 0) { printf("socket: errno %d\n", errno); return 3; }
  struct sockaddr_in6 at;
  memset(&at, 0, sizeof at);
  at.sin6_family = AF_INET6;
  at.sin6_port = htons(port);
  at.sin6_addr = in6addr_any;
  if (bind(fd, (struct sockaddr *)&at, sizeof at) < 0) { printf("bind: errno %d\n", errno); return 3; }
  if (!udp && listen(fd, 4) < 0) { printf("listen: errno %d\n", errno); return 3; }
  printf("listening\n");
  fflush(stdout);
  for (int i = 0; i < served; i++) {
    struct sockaddr_in6 from;
    socklen_t length = sizeof from;
    char name[64], buf[1024];
    if (udp) {
      ssize_t n = recvfrom(fd, buf, sizeof buf - 64, 0, (struct sockaddr *)&from, &length);
      if (n < 0) { printf("recvfrom: errno %d\n", errno); return 3; }
      inet_ntop(AF_INET6, &from.sin6_addr, name, sizeof name);
      printf("peer %s\n", name);
      fflush(stdout);
      for (ssize_t k = 0; k < n; k++) buf[k] = toupper((unsigned char)buf[k]);
      n += sprintf(buf + n, "|%s", name);
      sendto(fd, buf, n, 0, (struct sockaddr *)&from, length);
      continue;
    }
    int c = accept(fd, (struct sockaddr *)&from, &length);
    if (c < 0) { printf("accept: errno %d\n", errno); return 3; }
    inet_ntop(AF_INET6, &from.sin6_addr, name, sizeof name);
    printf("peer %s\n", name);
    fflush(stdout);
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
