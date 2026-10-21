// C++ on the sysroot's libc++, libc++abi and libunwind: exceptions unwind through destructors, and the standard
// library reaches the filesystem.
#include <cstdio>
#include <filesystem>
#include <map>
#include <stdexcept>
#include <string>

struct Counted {
  int *count;
  ~Counted() { ++*count; }
};

static int unwound = 0;

static void thrower(int depth) {
  Counted guard{&unwound};
  if (!depth) throw std::runtime_error("from below");
  thrower(depth - 1);
}

int main() {
  try {
    thrower(3);
  } catch (const std::exception &error) {
    std::printf("caught %s, %d destructors ran\n", error.what(), unwound);
  }
  try {
    throw 7;
  } catch (int value) {
    std::printf("caught int %d\n", value);
  }
  std::map<std::string, int> counts{{"a", 1}, {"b", 2}};
  std::printf("map size %zu, b=%d\n", counts.size(), counts["b"]);
  std::filesystem::create_directories("/tmp/wali-cxx-dir/one/two");
  int entries = 0;
  for (auto &entry : std::filesystem::recursive_directory_iterator("/tmp/wali-cxx-dir")) entries += entry.is_directory();
  std::printf("directories %d\n", entries);
  return 0;
}
