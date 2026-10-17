/* Ancillary data on local sockets, in one process: descriptors passed with SCM_RIGHTS over local AF_UNIX connections, files, pipes and sockets alike, a descriptor that outlives the sender's close(), where a read stops at a message that
 * carries one, MSG_CTRUNC, a plain read() that drops one, SO_PEERCRED and SO_PASSCRED, and the errors. */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>

#define NAME(e) (errno == (e) ? #e : "other")

static int send_fds(int sock, const char *text, const int *fds, int count) {
  char control[CMSG_SPACE(sizeof(int) * 4)];
  struct iovec io = { (void *)text, strlen(text) };
  struct msghdr m;
  memset(&m, 0, sizeof m);
  m.msg_iov = &io; m.msg_iovlen = 1;
  if (count > 0) {
    memset(control, 0, sizeof control);
    m.msg_control = control; m.msg_controllen = CMSG_SPACE(sizeof(int) * count);
    struct cmsghdr *c = CMSG_FIRSTHDR(&m);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int) * count);
    memcpy(CMSG_DATA(c), fds, sizeof(int) * count);
  }
  int r = sendmsg(sock, &m, 0);
  if (r < 0) printf("sendmsg errno %d\n", errno);
  return r;
}

/* receives into `text`; the descriptors that came go to `fds` (up to `room`), `*got` says how many; returns the byte count */
static int recv_fds(int sock, char *text, int size, int *fds, int room, int *got, int *flags, int *pid) {
  char control[CMSG_SPACE(sizeof(int) * 4) + CMSG_SPACE(sizeof(struct ucred))];
  struct iovec io = { text, size };
  struct msghdr m;
  memset(&m, 0, sizeof m);
  m.msg_iov = &io; m.msg_iovlen = 1;
  m.msg_control = control; m.msg_controllen = CMSG_SPACE(sizeof(int) * room) + (pid ? CMSG_SPACE(sizeof(struct ucred)) : 0);
  int n = recvmsg(sock, &m, 0);
  *got = 0; if (pid) *pid = -1;
  if (n >= 0) text[n] = 0;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&m); c; c = CMSG_NXTHDR(&m, c)) {
    if (c->cmsg_level != SOL_SOCKET) continue;
    if (c->cmsg_type == SCM_RIGHTS) { *got = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int); memcpy(fds, CMSG_DATA(c), *got * sizeof(int)); }
    if (c->cmsg_type == SCM_CREDENTIALS && pid) { struct ucred cr; memcpy(&cr, CMSG_DATA(c), sizeof cr); *pid = cr.pid; }
  }
  *flags = m.msg_flags;
  return n;
}

/* a connected pair of AF_UNIX stream sockets through a named socket (there is no socketpair here): pair[0] is the client, pair[1] the accepted end */
static void connect_pair(const char *path, int pair[2]) {
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un at;
  memset(&at, 0, sizeof at);
  at.sun_family = AF_UNIX; strcpy(at.sun_path, path);
  unlink(path);
  bind(server, (struct sockaddr *)&at, sizeof at);
  listen(server, 1);
  pair[0] = socket(AF_UNIX, SOCK_STREAM, 0);
  connect(pair[0], (struct sockaddr *)&at, sizeof at);
  pair[1] = accept(server, 0, 0);
}

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  int pair[2], fds[4], got, flags, n;
  char text[64];
  connect_pair("/tmp/scm-main.sock", pair);

  /* a file, closed by the sender before it is received */
  int file = open("/tmp/scm-file", O_CREAT | O_TRUNC | O_RDWR, 0644);
  printf("send-file %d\n", (int)send_fds(pair[0], "F", &file, 1));
  close(file);
  n = recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  printf("recv-file n=%d fds=%d ctrunc=%d\n", n, got, !!(flags & MSG_CTRUNC));
  write(fds[0], "via passed fd", 13);
  close(fds[0]);
  char back[32] = {0};
  int again = open("/tmp/scm-file", O_RDONLY);
  read(again, back, sizeof back - 1);
  printf("file-holds %s\n", back);

  /* a pipe's write end */
  int p[2];
  pipe(p);
  send_fds(pair[0], "P", &p[1], 1);
  recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  write(fds[0], "piped", 5);
  close(fds[0]); close(p[1]);
  memset(back, 0, sizeof back);
  read(p[0], back, sizeof back - 1); /* EOF only once every copy of the write end is closed */
  printf("pipe-holds %s\n", back);

  /* a pipe's write end sent and closed by the sender: while it is in flight the read end is not at its end */
  int q[2];
  pipe(q);
  send_fds(pair[0], "Q", &q[1], 1);
  close(q[1]);
  struct pollfd pf = { q[0], POLLIN, 0 };
  int ready = poll(&pf, 1, 0);
  printf("inflight-read %s\n", ready == 0 ? "waits" : "ready");
  recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  write(fds[0], "late", 4);
  close(fds[0]);
  memset(back, 0, sizeof back);
  read(q[0], back, sizeof back - 1);
  printf("inflight-data %s\n", back);
  close(q[0]);

  /* a read stops at the message that carries a descriptor, and does not run on past it */
  int f2 = open("/tmp/scm-file", O_RDONLY);
  write(pair[0], "AAA", 3);
  send_fds(pair[0], "BBB", &f2, 1);
  write(pair[0], "CCC", 3);
  n = recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  printf("bound1 n=%d %s fds=%d\n", n, text, got);
  n = recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  printf("bound2 n=%d %s fds=%d\n", n, text, got);
  close(fds[0]);
  n = recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  printf("bound3 n=%d %s fds=%d\n", n, text, got);

  /* too many for the buffer: MSG_CTRUNC, and the rest are not delivered */
  int two[2] = { f2, p[0] };
  send_fds(pair[0], "TT", two, 2);
  n = recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  printf("ctrunc n=%d fds=%d ctrunc=%d\n", n, got, !!(flags & MSG_CTRUNC));

  /* an ordinary read passing a descriptor drops it */
  send_fds(pair[0], "Z", &f2, 1);
  read(pair[1], text, 1);
  write(pair[0], "Y", 1);
  n = recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  printf("dropped n=%d %s fds=%d\n", n, text, got);

  /* a socket can be passed, and both ends keep working */
  int other[2];
  connect_pair("/tmp/scm-other.sock", other);
  write(other[0], "pre", 3);
  send_fds(pair[0], "S", &other[1], 1);
  recv_fds(pair[1], text, sizeof text, fds, 1, &got, &flags, 0);
  int moved = fds[0];
  write(other[0], "post", 4);
  memset(back, 0, sizeof back);
  n = read(moved, back, sizeof back - 1);
  printf("socket-passed %s\n", back);
  write(moved, "reply", 5);
  memset(back, 0, sizeof back);
  read(other[0], back, sizeof back - 1);
  printf("socket-reply %s\n", back);

  /* credentials */
  struct ucred cr; socklen_t len = sizeof cr;
  printf("peercred %d\n", getsockopt(pair[0], SOL_SOCKET, SO_PEERCRED, &cr, &len) == 0 && cr.pid > 0 && cr.uid == getuid());
  int on = 1;
  setsockopt(pair[1], SOL_SOCKET, SO_PASSCRED, &on, sizeof on);
  write(pair[0], "c", 1);
  int pid;
  recv_fds(pair[1], text, sizeof text, fds, 0, &got, &flags, &pid);
  printf("passcred %d\n", pid == cr.pid); /* the same program is at both ends */

  /* a named AF_UNIX connection */
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un at;
  memset(&at, 0, sizeof at);
  at.sun_family = AF_UNIX; strcpy(at.sun_path, "/tmp/scm.sock");
  unlink(at.sun_path);
  bind(server, (struct sockaddr *)&at, sizeof at);
  listen(server, 1);
  int client = socket(AF_UNIX, SOCK_STREAM, 0);
  connect(client, (struct sockaddr *)&at, sizeof at);
  int accepted = accept(server, 0, 0);
  int f3 = open("/tmp/scm-named", O_CREAT | O_TRUNC | O_WRONLY, 0644);
  send_fds(client, "N", &f3, 1);
  recv_fds(accepted, text, sizeof text, fds, 1, &got, &flags, 0);
  write(fds[0], "named", 5);
  close(fds[0]); close(f3);
  memset(back, 0, sizeof back);
  int named = open("/tmp/scm-named", O_RDONLY);
  read(named, back, sizeof back - 1);
  printf("named-holds %s\n", back);

  /* errors: a descriptor that is not open, and a kind of socket that cannot carry them */
  int bad = 77;
  errno = 0;
  printf("bad-fd %d %s\n", (int)send_fds(pair[0], "x", &bad, 1), NAME(EBADF));
  int udp = socket(AF_INET, SOCK_DGRAM, 0);
  errno = 0;
  printf("inet-rights %d %s\n", (int)send_fds(udp, "x", &f3, 1), NAME(EINVAL));
  return 0;
}
