/* long double as clang has it on this target, IEEE quad: libm reads its bytes in that layout, and printf, scanf and
 * strtold take it, where float.h said x86-64's 80-bit format (libm misread it) and long double formatting ended the
 * program. Doubles print as they did. */
#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  printf("mant=%d dig=%d\n", LDBL_MANT_DIG, LDBL_DIG);
  printf("sqrtl(2)=%.33Lg\n", sqrtl(2.0L));
  printf("fabsl(-3.5)=%Lg\n", fabsl(-3.5L));
  int e;
  long double m = frexpl(48.0L, &e);
  printf("frexpl(48)=%Lg*2^%d\n", m, e);
  long double third = 1.0L / 3;
  printf("third=%La %.36Lf\n", third, third);
  printf("epsilon=%d\n", strtold("0x1.0000000000000000000000000001p0", 0) - 1 == LDBL_EPSILON);
  long double scanned;
  sscanf("2.5e-4000", "%Lf", &scanned);
  printf("scanned=%Lg\n", scanned);
  printf("double=%.17g %g %f\n", 0.1, 1e300, -2.5);
  return 0;
}
