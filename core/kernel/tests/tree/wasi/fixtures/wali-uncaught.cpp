// An exception nothing catches ends the program by SIGABRT, as std::terminate would (src/bin/wali.mjs).
#include <stdexcept>

int main() {
  throw std::logic_error("nobody catches this");
}
