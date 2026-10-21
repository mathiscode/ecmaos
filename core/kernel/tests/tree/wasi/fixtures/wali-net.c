/* Sockets on WALI's musl: socketpair, AF_UNIX and loopback TCP between processes, poll and epoll, non-blocking calls,
 * SIGPIPE, and a socket handed to a child. The program starts copies of itself in the roles named by argv[1]; with no
 * role it runs the checks and prints what it found. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static const char *self;

static pid_t start(char *const argv[], posix_spawn_file_actions_t *actions) {
  pid_t pid;
  return posix_spawn(&pid, self, actions, 0, argv, environ) ? -1 : pid;
}

static int finish(pid_t pid) {
  int status;
  return waitpid(pid, &status, 0) == pid ? status : -1;
}

/* reads until the end of the stream or the buffer is full */
static int slurp(int fd, char *into, int room) {
  int got = 0, n;
  while (got < room - 1 && (n = read(fd, into + got, room - 1 - got)) > 0) got += n;
  into[got] = 0;
  return got;
}

static void upper(char *text) {
  for (; *text; text++) if (*text >= 'a' && *text <= 'z') *text -= 32;
}

/* --- the roles a child plays --- */

static int child(char **argv) {
  const char *role = argv[1];
  if (!strcmp(role, "unix") || !strcmp(role, "tcp")) {   /* connects, sends a line, prints what came back */
    int s;
    if (!strcmp(role, "unix")) {
      struct sockaddr_un to = { .sun_family = AF_UNIX };
      strcpy(to.sun_path, argv[2]);
      s = socket(AF_UNIX, SOCK_STREAM, 0);
      if (connect(s, (struct sockaddr *)&to, sizeof to)) return 10;
    } else {
      struct sockaddr_in to = { .sin_family = AF_INET, .sin_port = htons(atoi(argv[2])) };
      inet_pton(AF_INET, "127.0.0.1", &to.sin_addr);
      s = socket(AF_INET, SOCK_STREAM, 0);
      if (connect(s, (struct sockaddr *)&to, sizeof to)) return 11;
    }
    const char *line = "hello over the socket";
    send(s, line, strlen(line), 0);
    shutdown(s, SHUT_WR);
    char reply[64];
    slurp(s, reply, sizeof reply);
    printf("%s reply: %s\n", role, reply);
    return 0;
  }
  if (!strcmp(role, "say")) {                            /* its stdout is a socket */
    printf("said through an inherited socket\n");
    return 0;
  }
  if (!strcmp(role, "sigpipe")) {                        /* writes to a socket no one reads, SIGPIPE at its default */
    int sv[2];
    socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
    close(sv[1]);
    write(sv[0], "x", 1);
    return 0;
  }
  return 100;
}

/* accepts one connection, reads to the end, and sends it back in capitals */
static void serve(int listener) {
  int conn = accept(listener, 0, 0);
  char text[64];
  slurp(conn, text, sizeof text);
  upper(text);
  send(conn, text, strlen(text), 0);
  close(conn);
}

int main(int argc, char **argv) {
  self = argv[0];
  if (argc > 1) return child(argv);
  setvbuf(stdout, 0, _IONBF, 0);

  /* socketpair: both ways, MSG_PEEK, FIONREAD, and the end of the stream after shutdown */
  int sv[2];
  socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
  write(sv[0], "ping", 4);
  write(sv[1], "pong", 4);
  char a[8] = {0}, b[8] = {0}, peek[8] = {0};
  int waiting = 0;
  ioctl(sv[1], FIONREAD, &waiting);
  recv(sv[1], peek, 4, MSG_PEEK);
  read(sv[1], a, 4);
  read(sv[0], b, 4);
  shutdown(sv[0], SHUT_WR);
  char rest[8];
  struct stat st;
  fstat(sv[0], &st);
  printf("socketpair: %s %s peek=%s fionread=%d eof=%zd sock=%d\n", a, b, peek, waiting, read(sv[1], rest, sizeof rest), S_ISSOCK(st.st_mode));
  close(sv[0]);
  close(sv[1]);

  /* AF_UNIX between processes */
  unlink("/tmp/wali-net.sock");
  int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un here = { .sun_family = AF_UNIX, .sun_path = "/tmp/wali-net.sock" };
  int bound = bind(listener, (struct sockaddr *)&here, sizeof here);
  int listening = listen(listener, 4);
  pid_t pid = start((char *[]){ (char *)self, "unix", "/tmp/wali-net.sock", 0 }, 0);
  struct pollfd ready = { .fd = listener, .events = POLLIN };
  int polled = poll(&ready, 1, 5000);
  serve(listener);
  int status = finish(pid);
  printf("unix: bind=%d listen=%d poll=%d revents=%d exit=%d\n", bound, listening, polled, ready.revents, WEXITSTATUS(status));
  close(listener);

  /* loopback TCP, on a port the kernel picks */
  listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_in any = { .sin_family = AF_INET };
  inet_pton(AF_INET, "127.0.0.1", &any.sin_addr);
  bind(listener, (struct sockaddr *)&any, sizeof any);
  socklen_t length = sizeof any;
  getsockname(listener, (struct sockaddr *)&any, &length);
  listen(listener, 4);
  char port[16];
  snprintf(port, sizeof port, "%d", ntohs(any.sin_port));
  pid = start((char *[]){ (char *)self, "tcp", port, 0 }, 0);
  struct sockaddr_in peer;
  length = sizeof peer;
  int conn = accept(listener, (struct sockaddr *)&peer, &length);
  char text[64];
  slurp(conn, text, sizeof text);
  upper(text);
  send(conn, text, strlen(text), 0);
  close(conn);
  status = finish(pid);
  char where[INET_ADDRSTRLEN];
  inet_ntop(AF_INET, &peer.sin_addr, where, sizeof where);
  printf("tcp: port>0=%d peer=%s family=%d exit=%d\n", ntohs(any.sin_port) > 0, where, peer.sin_family, WEXITSTATUS(status));

  /* non-blocking: an empty accept, an empty recv, and a pipe set O_NONBLOCK with fcntl */
  fcntl(listener, F_SETFL, fcntl(listener, F_GETFL) | O_NONBLOCK);
  int empty = accept(listener, 0, 0);
  int acceptErrno = errno;
  close(listener);
  socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
  int nothing = recv(sv[0], text, sizeof text, MSG_DONTWAIT);
  int recvErrno = errno;
  int pipefd[2];
  pipe(pipefd);
  fcntl(pipefd[0], F_SETFL, O_NONBLOCK);
  int drained = read(pipefd[0], text, sizeof text);
  int pipeErrno = errno;
  printf("nonblock: accept=%d %s recv=%d %s pipe=%d %s getfl=%d\n", empty, acceptErrno == EAGAIN ? "EAGAIN" : strerror(acceptErrno),
    nothing, recvErrno == EAGAIN ? "EAGAIN" : strerror(recvErrno), drained, pipeErrno == EAGAIN ? "EAGAIN" : strerror(pipeErrno),
    (fcntl(pipefd[0], F_GETFL) & O_NONBLOCK) != 0);
  close(pipefd[0]);
  close(pipefd[1]);

  /* epoll: nothing, then a readable socket with its data */
  int ep = epoll_create1(EPOLL_CLOEXEC);
  struct epoll_event event = { .events = EPOLLIN, .data.u64 = 0x1234567890ULL }, got[4];
  int added = epoll_ctl(ep, EPOLL_CTL_ADD, sv[0], &event);
  int before = epoll_wait(ep, got, 4, 0);
  write(sv[1], "data", 4);
  int after = epoll_wait(ep, got, 4, 1000);
  printf("epoll: add=%d before=%d after=%d events=%d data=%llx again=%d\n", added, before, after, got[0].events & EPOLLIN,
    (unsigned long long)got[0].data.u64, epoll_ctl(ep, EPOLL_CTL_ADD, sv[0], &event) < 0 && errno == EEXIST);
  close(ep);
  close(sv[0]);
  close(sv[1]);

  /* a socket handed to a child as its stdout */
  socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv);
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, sv[1], 1);
  pid = start((char *[]){ (char *)self, "say", 0 }, &actions);
  posix_spawn_file_actions_destroy(&actions);
  close(sv[1]);
  slurp(sv[0], text, sizeof text);
  finish(pid);
  close(sv[0]);
  printf("inherited: %s", text);

  /* SIGPIPE: ignored, a write to a closed socket is EPIPE; at its default, it ends the writer */
  signal(SIGPIPE, SIG_IGN);
  socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
  close(sv[1]);
  int broken = write(sv[0], "x", 1);
  int brokenErrno = errno;
  close(sv[0]);
  signal(SIGPIPE, SIG_DFL);
  status = finish(start((char *[]){ (char *)self, "sigpipe", 0 }, 0));
  printf("sigpipe: write=%d %s child signaled=%d sig=%d\n", broken, brokenErrno == EPIPE ? "EPIPE" : strerror(brokenErrno),
    WIFSIGNALED(status), WIFSIGNALED(status) ? WTERMSIG(status) : 0);

  /* nothing listening */
  int refused = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in closed = { .sin_family = AF_INET, .sin_port = htons(9) };
  inet_pton(AF_INET, "127.0.0.1", &closed.sin_addr);
  int connected = connect(refused, (struct sockaddr *)&closed, sizeof closed);
  printf("refused: %d %s\n", connected, errno == ECONNREFUSED ? "ECONNREFUSED" : strerror(errno));
  return 0;
}
