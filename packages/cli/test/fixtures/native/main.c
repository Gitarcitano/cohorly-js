#include "native.h"

int main(int argc, char **argv) {
  (void)argv;
  int c = compute(argc * 10, argc + 3);
  double a = shapes_area(argc + 4, (double)c);
  return (int)a & 0x7f;
}
