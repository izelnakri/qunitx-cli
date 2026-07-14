// Source-under-test fixture for --coverage. `add` and `double` are exercised by the test;
// `subtract` and the negative branch of `abs` are intentionally left uncovered so the report
// has both hit and missed lines to assert on.
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function double(n: number): number {
  return n * 2;
}

export function abs(n: number): number {
  if (n < 0) {
    return -n;
  }
  return n;
}
