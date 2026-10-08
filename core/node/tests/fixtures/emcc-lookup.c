/* lookup NAME PORT [talk|byname]: prints the IPv4 addresses getaddrinfo gives for NAME, or the error; with "byname" it also calls gethostbyname; with "talk" it then connects to the
 * first one, sends "hello dns", and prints the reply. Exit 2 when the lookup fails, 3 when the connect does (errno printed). */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
  if (argc < 3) return 1;
  struct addrinfo hints, *res, *p;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  int rc = getaddrinfo(argv[1], argv[2], &hints, &res);
  if (rc) { printf("getaddrinfo: %s\n", gai_strerror(rc)); return 2; }
  for (p = res; p; p = p->ai_next) {
    char buf[64];
    struct sockaddr_in *sin = (struct sockaddr_in *)p->ai_addr;
    inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof buf);
    printf("%s:%d\n", buf, ntohs(sin->sin_port));
  }
  if (argc > 3 && !strcmp(argv[3], "byname")) {
    struct hostent *h = gethostbyname(argv[1]);
    if (!h) { printf("gethostbyname: failed\n"); return 4; }
    char buf[64];
    inet_ntop(AF_INET, h->h_addr_list[0], buf, sizeof buf);
    printf("gethostbyname %s\n", buf);
  }
  if (argc > 3 && !strcmp(argv[3], "talk")) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) { printf("connect: errno %d\n", errno); return 3; }
    write(fd, "hello dns", 9);
    char reply[64];
    int n = read(fd, reply, sizeof reply - 1);
    if (n > 0) { reply[n] = 0; printf("%s\n", reply); }
  }
  freeaddrinfo(res);
  return 0;
}
