/* One process, IPv6 on loopback only (no gateway). Name resolution (getaddrinfo, getnameinfo), a v6-only TCP server and a dual-stack one
 * reached from both families, how the two kinds of listener share a port, an IPv6 UDP exchange, and the errors for a wrong address family
 * and for a destination beyond this machine. */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

#define NAME(e) (errno == (e) ? #e : "other")

static void show(const char *label, const struct sockaddr *sa, socklen_t len) {
  char host[64], serv[16];
  int rc = getnameinfo(sa, len, host, sizeof host, serv, sizeof serv, NI_NUMERICHOST | NI_NUMERICSERV);
  printf("%s fam=%d len=%d %s port=%s\n", label, sa->sa_family, (int)len, rc ? "?" : host, serv);
}

static struct sockaddr_in6 six(const char *address, int port) {
  struct sockaddr_in6 at;
  memset(&at, 0, sizeof at);
  at.sin6_family = AF_INET6;
  at.sin6_port = htons(port);
  inet_pton(AF_INET6, address, &at.sin6_addr);
  return at;
}

static int server6(const char *address, int port, int v6only) {
  int fd = socket(AF_INET6, SOCK_STREAM, 0);
  setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, sizeof v6only);
  struct sockaddr_in6 at = six(address, port);
  if (bind(fd, (struct sockaddr *)&at, sizeof at) < 0) return -1;
  listen(fd, 4);
  return fd;
}

static void list(const char *label, const char *node, int family, int flags) {
  struct addrinfo hints, *res = 0;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = family;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = flags;
  int rc = getaddrinfo(node, "80", &hints, &res);
  if (rc) { printf("%s failed\n", label); return; }
  for (struct addrinfo *p = res; p; p = p->ai_next) show(label, p->ai_addr, p->ai_addrlen);
}

int main(void) {
  struct sockaddr_storage ss;
  socklen_t len;
  char buf[16];

  list("gai-literal", "::1", AF_UNSPEC, AI_NUMERICHOST);
  list("gai-localhost", "localhost", AF_UNSPEC, 0);
  list("gai-passive6", 0, AF_INET6, AI_PASSIVE);
  list("gai-passive-any", 0, AF_UNSPEC, AI_PASSIVE);
  list("gai-wrong-family", "::1", AF_INET, 0);
  { /* reverse: /etc/hosts names loopback, and 80 is http */
    struct sockaddr_in6 at = six("::1", 80);
    char host[64], serv[16];
    int rc = getnameinfo((struct sockaddr *)&at, sizeof at, host, sizeof host, serv, sizeof serv, 0);
    printf("reverse rc=%d %s %s\n", rc, host, serv);
    rc = getnameinfo((struct sockaddr *)&at, sizeof at, host, 3, serv, sizeof serv, NI_NUMERICHOST);
    printf("short buffer rc=%d\n", rc);
  }

  /* a v6-only TCP server and a client over ::1 */
  int s = server6("::1", 5501, 1);
  int c = socket(AF_INET6, SOCK_STREAM, 0);
  struct sockaddr_in6 to = six("::1", 5501);
  printf("connect6 %d\n", connect(c, (struct sockaddr *)&to, sizeof to));
  len = sizeof ss;
  int a = accept(s, (struct sockaddr *)&ss, &len);
  show("accepted", (struct sockaddr *)&ss, len);
  write(c, "ping6", 5);
  memset(buf, 0, sizeof buf);
  read(a, buf, sizeof buf);
  printf("server read %s\n", buf);
  len = sizeof ss;
  getsockname(s, (struct sockaddr *)&ss, &len);
  show("sockname", (struct sockaddr *)&ss, len);

  /* a dual-stack server takes an IPv4 client (shown mapped) and an IPv6 one */
  int d = server6("::", 5502, 0);
  int c4 = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in v4;
  memset(&v4, 0, sizeof v4);
  v4.sin_family = AF_INET; v4.sin_port = htons(5502); inet_pton(AF_INET, "127.0.0.1", &v4.sin_addr);
  printf("connect4-to-dual %d\n", connect(c4, (struct sockaddr *)&v4, sizeof v4));
  len = sizeof ss;
  int a4 = accept(d, (struct sockaddr *)&ss, &len);
  show("dual-from-v4", (struct sockaddr *)&ss, len);
  int c6 = socket(AF_INET6, SOCK_STREAM, 0);
  struct sockaddr_in6 to6 = six("::1", 5502);
  printf("connect6-to-dual %d\n", connect(c6, (struct sockaddr *)&to6, sizeof to6));
  len = sizeof ss;
  int a6 = accept(d, (struct sockaddr *)&ss, &len);
  show("dual-from-v6", (struct sockaddr *)&ss, len);
  (void)a4; (void)a6;

  /* sharing a port: dual-stack holds both families; a v6-only listener leaves the IPv4 one free */
  int again = socket(AF_INET, SOCK_STREAM, 0);
  memset(&v4, 0, sizeof v4);
  v4.sin_family = AF_INET; v4.sin_port = htons(5502);
  errno = 0;
  printf("v4-bind-over-dual %d %s\n", bind(again, (struct sockaddr *)&v4, sizeof v4), NAME(EADDRINUSE));
  int only = server6("::1", 5503, 1);
  int four = socket(AF_INET, SOCK_STREAM, 0);
  memset(&v4, 0, sizeof v4);
  v4.sin_family = AF_INET; v4.sin_port = htons(5503);
  printf("v4-beside-v6only %d %d\n", only >= 0, bind(four, (struct sockaddr *)&v4, sizeof v4));
  { int v = 99; socklen_t n = sizeof v; getsockopt(s, IPPROTO_IPV6, IPV6_V6ONLY, &v, &n); printf("v6only=%d\n", v); }

  /* IPv6 UDP: a bound socket and an unbound one */
  int u1 = socket(AF_INET6, SOCK_DGRAM, 0);
  struct sockaddr_in6 at = six("::1", 5504);
  printf("udp-bind %d\n", bind(u1, (struct sockaddr *)&at, sizeof at));
  int u2 = socket(AF_INET6, SOCK_DGRAM, 0);
  printf("udp-send %d\n", (int)sendto(u2, "dgram6", 6, 0, (struct sockaddr *)&at, sizeof at));
  len = sizeof ss;
  memset(buf, 0, sizeof buf);
  int n = recvfrom(u1, buf, sizeof buf, 0, (struct sockaddr *)&ss, &len);
  show("udp-from", (struct sockaddr *)&ss, len);
  printf("udp-got %d %s\n", n, buf);
  sendto(u1, "back", 4, 0, (struct sockaddr *)&ss, len);
  len = sizeof ss;
  memset(buf, 0, sizeof buf);
  n = recvfrom(u2, buf, sizeof buf, 0, (struct sockaddr *)&ss, &len);
  show("udp-reply-from", (struct sockaddr *)&ss, len);
  printf("udp-reply %d %s\n", n, buf);

  /* wrong family for the socket */
  int w = socket(AF_INET, SOCK_STREAM, 0);
  at = six("::1", 5505);
  errno = 0;
  printf("v4-socket-v6-address %d %s\n", bind(w, (struct sockaddr *)&at, sizeof at), NAME(EAFNOSUPPORT));
  int x = socket(AF_INET6, SOCK_STREAM, 0);
  memset(&v4, 0, sizeof v4);
  v4.sin_family = AF_INET; v4.sin_port = htons(5503); inet_pton(AF_INET, "127.0.0.1", &v4.sin_addr);
  errno = 0;
  printf("v6-socket-v4-address %d %s\n", connect(x, (struct sockaddr *)&v4, sizeof v4), NAME(EINVAL));

  /* beyond this machine, with no gateway */
  int far = socket(AF_INET6, SOCK_STREAM, 0);
  struct sockaddr_in6 away = six("2001:db8::1", 80);
  errno = 0;
  printf("far-connect %d %s\n", connect(far, (struct sockaddr *)&away, sizeof away), NAME(ENETUNREACH));
  errno = 0;
  printf("far-send %d %s\n", (int)sendto(u2, "x", 1, 0, (struct sockaddr *)&away, sizeof away), NAME(ENETUNREACH));
  return 0;
}
