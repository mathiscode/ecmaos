/* setjmp and longjmp on WebAssembly exception handling (the sysroot's musl patch 0002). */
#include <setjmp.h>
#include <stdio.h>

static jmp_buf jump;

static void deep(int n) {
  if (n == 0) longjmp(jump, 42);
  deep(n - 1);
}

int main(void) {
  volatile int tries = 0;
  int value = setjmp(jump);
  if (value == 0) deep(5);
  printf("longjmp from 5 calls down: %d\n", value);
  value = setjmp(jump);
  if (value == 0 && tries++ == 0) longjmp(jump, 0);
  printf("longjmp(0) arrives as %d after %d\n", value, tries);
  return 0;
}
