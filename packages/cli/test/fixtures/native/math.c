#include "native.h"

static inline __attribute__((always_inline)) int square(int x) {
  return x * x + (x >> 3);
}

static inline __attribute__((always_inline)) int sum_squares(int a, int b) {
  int s = square(a);
  s += square(b ^ 7);
  return s;
}

int compute(int a, int b) {
  int total = 0;
  for (int i = 0; i < a; i++) {
    total += sum_squares(i, b + i);
  }
  return total;
}
