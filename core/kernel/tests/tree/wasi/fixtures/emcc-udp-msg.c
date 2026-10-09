/* One process, loopback UDP only. Two servers bind 127.0.0.1:5401 and :5402. An UNBOUND client socket sends "he"+"llo" with sendmsg to the
 * first and "second" with sendto to the second (so one socket talks to two peers). Each server receives with recvmsg into two buffers
 * (3 and 10 bytes), checks the sender's address, and answers with sendmsg to msg_name. The client reads both replies with recvmsg and
 * prints who each came from. A send to an address beyond this machine with no gateway must fail with ENETUNREACH. */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <ctype.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/uio.h>

static int bound(int port) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in at;
  memset(&at, 0, sizeof at);
  at.sin_family = AF_INET;
  at.sin_port = htons(port);
  inet_pton(AF_INET, "127.0.0.1", &at.sin_addr);
  if (bind(fd, (struct sockaddr *)&at, sizeof at) < 0) { printf("bind %d: errno %d\n", port, errno); return -1; }
  return fd;
}

static struct sockaddr_in to(int port, const char *address) {
  struct sockaddr_in at;
  memset(&at, 0, sizeof at);
  at.sin_family = AF_INET;
  at.sin_port = htons(port);
  inet_pton(AF_INET, address, &at.sin_addr);
  return at;
}

/* receive with two buffers, print the split, answer upper-cased to whoever sent it */
static void serve(int fd, const char *name) {
  char a[3], b[10];
  struct iovec in[2] = { { a, sizeof a }, { b, sizeof b } };
  struct sockaddr_in from;
  struct msghdr m;
  memset(&m, 0, sizeof m);
  m.msg_name = &from; m.msg_namelen = sizeof from; m.msg_iov = in; m.msg_iovlen = 2;
  ssize_t n = recvmsg(fd, &m, 0);
  if (n < 0) { printf("%s recvmsg: errno %d\n", name, errno); return; }
  printf("%s got %zd = [%.*s][%.*s] from %s\n", name, n, n > 3 ? 3 : (int)n, a, n > 3 ? (int)n - 3 : 0, b, inet_ntoa(from.sin_addr));
  char up[16];
  for (ssize_t k = 0; k < n; k++) up[k] = k < 3 ? toupper(a[k]) : toupper(b[k - 3]);
  struct iovec out = { up, (size_t)n };
  struct msghdr r;
  memset(&r, 0, sizeof r);
  r.msg_name = &from; r.msg_namelen = m.msg_namelen; r.msg_iov = &out; r.msg_iovlen = 1;
  if (sendmsg(fd, &r, 0) < 0) printf("%s sendmsg: errno %d\n", name, errno);
}

int main(void) {
  int s1 = bound(5401), s2 = bound(5402);
  if (s1 < 0 || s2 < 0) return 3;
  int c = socket(AF_INET, SOCK_DGRAM, 0);

  char p1[] = "he", p2[] = "llo";
  struct iovec out[2] = { { p1, 2 }, { p2, 3 } };
  struct sockaddr_in first = to(5401, "127.0.0.1");
  struct msghdr m;
  memset(&m, 0, sizeof m);
  m.msg_name = &first; m.msg_namelen = sizeof first; m.msg_iov = out; m.msg_iovlen = 2;
  if (sendmsg(c, &m, 0) != 5) { printf("client sendmsg: errno %d\n", errno); return 3; }
  struct sockaddr_in second = to(5402, "127.0.0.1");
  if (sendto(c, "second", 6, 0, (struct sockaddr *)&second, sizeof second) != 6) { printf("client sendto: errno %d\n", errno); return 3; }

  serve(s1, "one");
  serve(s2, "two");

  for (int i = 0; i < 2; i++) {
    char buf[32];
    struct iovec in = { buf, sizeof buf - 1 };
    struct sockaddr_in from;
    struct msghdr r;
    memset(&r, 0, sizeof r);
    r.msg_name = &from; r.msg_namelen = sizeof from; r.msg_iov = &in; r.msg_iovlen = 1;
    ssize_t n = recvmsg(c, &r, 0);
    if (n < 0) { printf("client recvmsg: errno %d\n", errno); return 3; }
    buf[n] = 0;
    printf("client got [%s] from port %d (namelen %d, control %d)\n", buf, ntohs(from.sin_port), (int)r.msg_namelen, (int)r.msg_controllen);
  }

  struct sockaddr_in far = to(53, "93.184.216.34");
  ssize_t n = sendto(c, "x", 1, 0, (struct sockaddr *)&far, sizeof far);
  printf("far %zd errno %d\n", n, n < 0 ? errno : 0);
  return 0;
}
