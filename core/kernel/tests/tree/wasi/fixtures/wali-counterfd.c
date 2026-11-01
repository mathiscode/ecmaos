/* eventfd and timerfd on WALI's musl: the counter reads as the sum of what was written (one at a time with
 * EFD_SEMAPHORE), a read of an empty one waits or fails with EAGAIN, a timer adds an expiration at each tick, and
 * epoll sees them ready. A child writes to the eventfd the parent waits on in epoll_wait. */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/timerfd.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static uint64_t take(int fd) {
  uint64_t value = 0;
  ssize_t n = read(fd, &value, sizeof value);
  return n == (ssize_t)sizeof value ? value : (uint64_t)-1;
}

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);

  int ev = eventfd(3, EFD_NONBLOCK);
  uint64_t add = 4;
  write(ev, &add, sizeof add);
  printf("eventfd sum: %llu\n", (unsigned long long)take(ev));
  uint64_t again = take(ev);
  printf("empty: %s\n", again == (uint64_t)-1 && errno == EAGAIN ? "EAGAIN" : "other");
  uint64_t bad = 0xffffffffffffffffULL;
  printf("bad value: %s\n", write(ev, &bad, sizeof bad) < 0 && errno == EINVAL ? "EINVAL" : "other");
  char small[4];
  uint64_t filler = 1;
  write(ev, &filler, sizeof filler);
  printf("short read: %s\n", read(ev, small, sizeof small) < 0 && errno == EINVAL ? "EINVAL" : "other");
  take(ev);

  int sem = eventfd(2, EFD_SEMAPHORE | EFD_NONBLOCK);
  uint64_t a = take(sem), b = take(sem), c = take(sem);
  printf("semaphore: %llu %llu %s\n", (unsigned long long)a, (unsigned long long)b, c == (uint64_t)-1 ? "empty" : "more");

  struct pollfd pfd = { .fd = ev, .events = POLLIN | POLLOUT };
  poll(&pfd, 1, 0);
  printf("poll idle: in=%d out=%d\n", !!(pfd.revents & POLLIN), !!(pfd.revents & POLLOUT));
  uint64_t one = 1;
  write(ev, &one, sizeof one);
  poll(&pfd, 1, 0);
  printf("poll counted: in=%d out=%d\n", !!(pfd.revents & POLLIN), !!(pfd.revents & POLLOUT));
  take(ev);

  int tf = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK);
  struct itimerspec spec = { .it_interval = { 0, 0 }, .it_value = { 0, 30 * 1000000 } };
  timerfd_settime(tf, 0, &spec, 0);
  struct itimerspec left;
  timerfd_gettime(tf, &left);
  printf("armed: left>0=%d left<=30ms=%d\n", left.it_value.tv_sec * 1000000000L + left.it_value.tv_nsec > 0,
         left.it_value.tv_sec * 1000000000L + left.it_value.tv_nsec <= 30000000L);
  printf("not yet: %s\n", take(tf) == (uint64_t)-1 && errno == EAGAIN ? "EAGAIN" : "other");

  int ep = epoll_create1(0);
  struct epoll_event event = { .events = EPOLLIN, .data.u32 = 7 };
  epoll_ctl(ep, EPOLL_CTL_ADD, tf, &event);
  event.data.u32 = 9;
  epoll_ctl(ep, EPOLL_CTL_ADD, ev, &event);
  struct epoll_event out[2];
  int ready = epoll_wait(ep, out, 2, 2000);
  printf("epoll timer: ready=%d tag=%u count=%llu\n", ready, ready > 0 ? out[0].data.u32 : 0, (unsigned long long)take(tf));
  timerfd_gettime(tf, &left);
  printf("one shot spent: %d\n", left.it_value.tv_sec == 0 && left.it_value.tv_nsec == 0);

  struct itimerspec every = { .it_interval = { 0, 10 * 1000000 }, .it_value = { 0, 10 * 1000000 } };
  timerfd_settime(tf, 0, &every, 0);
  struct timespec pause = { 0, 100 * 1000000 };
  nanosleep(&pause, 0);
  uint64_t ticks = take(tf);
  printf("interval: ticks>=5=%d\n", ticks != (uint64_t)-1 && ticks >= 5);
  struct itimerspec stop = { 0 };
  timerfd_settime(tf, 0, &stop, 0);
  nanosleep(&pause, 0);
  printf("disarmed: %s\n", take(tf) == (uint64_t)-1 ? "silent" : "ticked");

  pid_t child = fork();
  if (child == 0) {
    struct timespec wait = { 0, 50 * 1000000 };
    nanosleep(&wait, 0);
    uint64_t seven = 7;
    write(ev, &seven, sizeof seven);
    _exit(0);
  }
  ready = epoll_wait(ep, out, 2, 3000);
  printf("child wakes epoll: ready=%d tag=%u count=%llu\n", ready, ready > 0 ? out[0].data.u32 : 0, (unsigned long long)take(ev));
  int status;
  waitpid(child, &status, 0);
  printf("child exit=%d\n", WEXITSTATUS(status));

  printf("bad clock: %s\n", timerfd_create(99, 0) < 0 && errno == EINVAL ? "EINVAL" : "other");
  printf("bad fd: %s\n", timerfd_settime(ev, 0, &spec, 0) < 0 && errno == EINVAL ? "EINVAL" : "other");
  return 0;
}
