// fork inside a try block, where the frames to rebuild include an exception handler: the child throws and catches,
// and the parent leaves the block as it normally does
#include <cstdio>
#include <stdexcept>
#include <string>
#include <sys/wait.h>
#include <unistd.h>

struct Guard {
  int *count;
  explicit Guard(int *c) : count(c) {}
  ~Guard() { ++*count; }
};

int main()
{
  int destroyed = 0;
  std::string name = "inside";
  try {
    Guard guard(&destroyed);
    pid_t pid = fork();
    if (pid == 0) {
      try {
        throw std::runtime_error(name);
      } catch (const std::exception &e) {
        std::fputs(e.what(), stderr);
        _exit(destroyed == 0 ? 21 : 22);
      }
    }
    int status;
    waitpid(pid, &status, 0);
    std::printf("child exit=%d\n", WEXITSTATUS(status));
    throw std::runtime_error("parent");
  } catch (const std::exception &e) {
    std::printf("parent caught %s, destroyed=%d\n", e.what(), destroyed);
  }
  return 0;
}
