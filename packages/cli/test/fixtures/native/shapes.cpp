#include "native.h"

namespace geo {
struct Polygon {
  int sides;
  double size;
};

static inline __attribute__((always_inline)) double perimeter(const Polygon &p) {
  return p.sides * p.size;
}

__attribute__((noinline)) double area(const Polygon &p) {
  double per = perimeter(p);
  return per * p.size / (p.sides > 4 ? 4.0 : 2.0);
}
}

extern "C" double shapes_area(int sides, double size) {
  geo::Polygon p{sides, size};
  return geo::area(p) + perimeter(p);
}
