package com.crucible.conformance;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Execution canary for the resolve helper's "no test executes during resolve"
 * guarantee (task P3-03).
 *
 * <p>The side effect lives in the <em>method body</em>, which only runs on
 * execution — class loading during discovery runs static initializers, not
 * method bodies. When {@code crucible.canary.dir} is set, executing this test
 * writes {@code canary-executed.txt} into that directory. So:
 *
 * <ul>
 *   <li><b>resolve</b> (Launcher {@code discover}) loads this class but never
 *       runs the body → the marker is absent. If resolve ever regressed to
 *       {@code execute}, the marker would appear and the P3-03 canary test
 *       would fail.
 *   <li><b>positive control</b> — a real {@code mvn test} / {@code gradle test}
 *       with {@code -Dcrucible.canary.dir=<dir>} <em>does</em> write the marker,
 *       proving the mechanism actually fires when the body runs.
 * </ul>
 *
 * <p>With the property unset (the default under plain {@code mvn test}) it is an
 * ordinary passing test that touches nothing.
 */
class CanaryTest {
  static final String MARKER_FILENAME = "canary-executed.txt";

  @Test
  void writesMarkerWhenExecuted() throws Exception {
    String dir = System.getProperty("crucible.canary.dir");
    if (dir != null) {
      Files.writeString(Path.of(dir, MARKER_FILENAME), "executed\n");
    }
    assertTrue(true);
  }
}
