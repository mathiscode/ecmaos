/* scm-peer serve SOCKET: accepts one connection, receives a descriptor with SCM_RIGHTS, writes "written by the receiver" to it, and answers "done".
 * scm-peer send SOCKET FILE: connects, opens FILE for writing, sends the descriptor, closes its own copy and waits for the
 * answer, which it takes with recvmsg (as a Wayland client reads), then says which process SO_PEERCRED names.
 * Two programs: the descriptor has to cross from one process's table into the other's. */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>

int main(int argc, char **argv) {
  if (argc < 3) return 1;
  struct sockaddr_un at;
  memset(&at, 0, sizeof at);
  at.sun_family = AF_UNIX; strncpy(at.sun_path, argv[2], sizeof at.sun_path - 1);
  setvbuf(stdout, 0, _IONBF, 0);
  if (!strcmp(argv[1], "serve")) {
    int s = socket(AF_UNIX, SOCK_STREAM, 0);
    unlink(argv[2]);
    if (bind(s, (struct sockaddr *)&at, sizeof at) < 0 || listen(s, 1) < 0) return 2;
    printf("listening\n");
    int c = accept(s, 0, 0);
    char data[8], control[CMSG_SPACE(sizeof(int))];
    struct iovec io = { data, sizeof data };
    struct msghdr m;
    memset(&m, 0, sizeof m);
    m.msg_iov = &io; m.msg_iovlen = 1; m.msg_control = control; m.msg_controllen = sizeof control;
    int n = recvmsg(c, &m, 0);
    struct cmsghdr *h = CMSG_FIRSTHDR(&m);
    if (n < 0 || !h || h->cmsg_type != SCM_RIGHTS) { printf("no descriptor\n"); return 3; }
    int fd;
    memcpy(&fd, CMSG_DATA(h), sizeof fd);
    write(fd, "written by the receiver", 23);
    close(fd);
    write(c, "done", 4);
    printf("received\n");
    return 0;
  }
  int c = socket(AF_UNIX, SOCK_STREAM, 0);
  if (connect(c, (struct sockaddr *)&at, sizeof at) < 0) { printf("connect failed\n"); return 2; }
  int file = open(argc > 3 ? argv[3] : "/tmp/scm-peer-file", O_CREAT | O_TRUNC | O_WRONLY, 0644);
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof control);
  struct iovec io = { "F", 1 };
  struct msghdr m;
  memset(&m, 0, sizeof m);
  m.msg_iov = &io; m.msg_iovlen = 1; m.msg_control = control; m.msg_controllen = sizeof control;
  struct cmsghdr *h = CMSG_FIRSTHDR(&m);
  h->cmsg_level = SOL_SOCKET; h->cmsg_type = SCM_RIGHTS; h->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(h), &file, sizeof file);
  if (sendmsg(c, &m, 0) < 0) { printf("sendmsg failed\n"); return 3; }
  close(file);
  char answer[8] = {0}, room[CMSG_SPACE(sizeof(int))];
  struct iovec in = { answer, sizeof answer - 1 };
  struct msghdr r;
  memset(&r, 0, sizeof r);
  r.msg_iov = &in; r.msg_iovlen = 1; r.msg_control = room; r.msg_controllen = sizeof room;
  if (recvmsg(c, &r, 0) < 0) { printf("recvmsg failed\n"); return 4; }
  printf("answer %s\n", answer);
  struct ucred peer;
  socklen_t size = sizeof peer;
  if (getsockopt(c, SOL_SOCKET, SO_PEERCRED, &peer, &size) == 0) printf("peer pid %d\n", (int)peer.pid);
  return 0;
}
