package com.crucible.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

/**
 * Plain {@code @Test} methods — the addressable subset an oracle may bind to.
 * Declares three of the fixture's five conformance categories:
 *
 * <ul>
 *   <li>PASS  — {@link #addsTwoNumbers}, {@link #subtractsTwoNumbers}
 *   <li>FAIL  — {@link #failsOnPurpose} (a deliberate, documented red)
 *   <li>SKIP  — {@link #skippedFeature} ({@code @Disabled})
 * </ul>
 *
 * All three are plain concrete methods, so {@code resolve} classifies every one
 * of them as {@code found}: resolve discovers, it does not run — skip and fail
 * are runtime outcomes the adapter's {@code run} verb reports later.
 */
class CalculatorTest {
  private final Calculator calc = new Calculator();

  @Test
  void addsTwoNumbers() {
    assertEquals(5, calc.add(2, 3));
  }

  @Test
  void subtractsTwoNumbers() {
    assertEquals(1, calc.subtract(3, 2));
  }

  /**
   * FAIL category: this assertion is wrong on purpose. {@code mvn test} /
   * {@code gradle test} therefore end non-zero — the failing test is the point.
   * Surefire / JUnit XML still records every test's outcome (the runner reads
   * that, not the aggregate exit code).
   */
  @Test
  void failsOnPurpose() {
    assertEquals(0, calc.add(2, 3), "intentional conformance failure: 2 + 3 != 0");
  }

  /** SKIP category: {@code @Disabled} — discovered by resolve, never executed. */
  @Disabled("conformance skip category: intentionally disabled")
  @Test
  void skippedFeature() {
    fail("this body must never run — the method is @Disabled");
  }
}
