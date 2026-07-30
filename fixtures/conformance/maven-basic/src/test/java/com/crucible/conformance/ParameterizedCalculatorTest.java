package com.crucible.conformance;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * PARAMETERIZED category. A {@code @ParameterizedTest} is a JUnit test
 * <em>template</em>: at discovery time it is a container, and its concrete
 * invocations do not exist until execution. It therefore has no single
 * addressable method identity, so the resolve helper classifies it
 * {@code unsupported} and it is <em>excluded</em> from oracle addressing (design
 * phase-3.md §1, the addressable-subset rule). It still runs green under a plain
 * {@code mvn test} / {@code gradle test} — it is excluded from <em>binding</em>,
 * not from the build.
 */
class ParameterizedCalculatorTest {
  private final Calculator calc = new Calculator();

  @ParameterizedTest
  @ValueSource(ints = {2, 4, 6, 8})
  void evensAreEven(int n) {
    assertTrue(calc.isEven(n));
  }
}
