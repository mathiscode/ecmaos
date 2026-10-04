/* Raw-mode terminal probe: isatty, tcgetattr/tcsetattr, TIOCGWINSZ, poll with a timeout, one key. */
#include <stdio.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <poll.h>
#include <unistd.h>

int main(void) {
  struct termios saved, raw;
  struct winsize w = {0};
  printf("isatty=%d\n", isatty(0));
  if (tcgetattr(0, &saved)) { perror("tcgetattr"); return 1; }
  raw = saved;
  cfmakeraw(&raw);
  if (tcsetattr(0, TCSANOW, &raw)) { perror("tcsetattr"); return 1; }
  if (ioctl(0, TIOCGWINSZ, &w)) perror("winsize");
  struct pollfd idle = {0, POLLIN, 0};
  int none = poll(&idle, 1, 50);
  struct pollfd p = {0, POLLIN, 0};
  int r = poll(&p, 1, 5000);
  char c = 0;
  if (r > 0) read(0, &c, 1);
  tcsetattr(0, TCSANOW, &saved);
  printf("size=%dx%d idle=%d poll=%d key=%c\n", w.ws_col, w.ws_row, none, r, c);
  fflush(stdout);
  return 0;
}
