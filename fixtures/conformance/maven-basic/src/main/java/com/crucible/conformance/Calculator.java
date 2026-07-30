package com.crucible.conformance;

/**
 * Trivial production class under test. Exists only to give the conformance
 * fixture's oracle tests something real to assert against — the fixture proves
 * the adapter wire protocol, not any interesting arithmetic.
 */
public final class Calculator {
  public int add(int a, int b) {
    return a + b;
  }

  public int subtract(int a, int b) {
    return a - b;
  }

  public boolean isEven(int n) {
    return n % 2 == 0;
  }
}
