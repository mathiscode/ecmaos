/* udp HOST PORT MODE: MODE "sendto" uses sendto()/recvfrom() on an unconnected socket, "connect" uses connect()/write()/read().
 * Sends "ping udp", prints the reply, then sends a 3000-byte datagram and prints how many bytes came back (and that the
 * first and last bytes survived). Exit 3 when a call fails (errno printed). */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
  if (argc < 4) return 1;
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) { printf("socket: errno %d\n", errno); return 3; }
  struct sockaddr_in to;
  memset(&to, 0, sizeof to);
  to.sin_family = AF_INET;
  to.sin_port = htons(atoi(argv[2]));
  inet_pton(AF_INET, argv[1], &to.sin_addr);
  int sendto_mode = !strcmp(argv[3], "sendto");
  if (!sendto_mode && connect(fd, (struct sockaddr *)&to, sizeof to) < 0) { printf("connect: errno %d\n", errno); return 3; }

  char reply[4096];
  struct sockaddr_in from;
  socklen_t fromlen = sizeof from;
  ssize_t n;
  if (sendto_mode) {
    if (sendto(fd, "ping udp", 8, 0, (struct sockaddr *)&to, sizeof to) < 0) { printf("sendto: errno %d\n", errno); return 3; }
    n = recvfrom(fd, reply, sizeof reply - 1, 0, (struct sockaddr *)&from, &fromlen);
    if (n > 0) printf("from port %d\n", ntohs(from.sin_port));
  } else {
    if (write(fd, "ping udp", 8) < 0) { printf("write: errno %d\n", errno); return 3; }
    n = read(fd, reply, sizeof reply - 1);
  }
  if (n < 0) { printf("recv: errno %d\n", errno); return 3; }
  reply[n] = 0;
  printf("%s\n", reply);

  char big[3000];
  memset(big, 'a', sizeof big);
  big[0] = 'b'; big[sizeof big - 1] = 'c';
  if (send(fd, big, sizeof big, 0) < 0) { printf("send: errno %d\n", errno); return 3; }
  n = recv(fd, reply, sizeof reply, 0);
  printf("big %zd %c %c\n", n, n > 0 ? reply[0] : '?', n > 0 ? reply[n - 1] : '?');
  close(fd);
  return 0;
}
