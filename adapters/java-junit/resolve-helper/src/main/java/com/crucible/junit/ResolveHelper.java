package com.crucible.junit;

import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClass;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.platform.engine.TestDescriptor;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.LauncherDiscoveryRequest;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;

/**
 * Resolve helper for the {@code java-junit} adapter (task P3-03, design
 * phase-3.md §2). Given adapter target strings ({@code com.acme.FooTest#bar}) it
 * classifies each — <b>without ever executing a test</b> — as one of three:
 *
 * <ul>
 *   <li>{@code found} — a plain, addressable {@code @Test} method exists.
 *   <li>{@code unsupported} — the target names a test <em>template</em>
 *       ({@code @ParameterizedTest} / {@code @TestFactory}): at discovery time it
 *       is a container with no single addressable invocation, so it is excluded
 *       from oracle addressing (the addressable-subset rule).
 *   <li>{@code missing} — no such class, no such method, or the method exists
 *       reflectively but carries no test annotation.
 * </ul>
 *
 * <p>It uses only {@link Launcher#discover} — the JUnit Platform's discovery
 * pass, which reflects over classes to build the descriptor tree but never runs
 * a test body. The three-way result is the helper's own vocabulary; the adapter
 * wrapper later folds {@code unsupported} → {@code missing} for the wire (design
 * §2), which fails closed at propose time.
 *
 * <p>Output: a single JSON object on stdout,
 * {@code {"results":[{"target","classification","className"?,"methodName"?}]}},
 * one entry per argument, in input order. An absent target class is classified
 * {@code missing}; a linkage or discovery failure for an existing class makes
 * the helper fail nonzero, so the adapter cannot mistake an unloadable target
 * for a clean resolution result.
 */
public final class ResolveHelper {

  private enum Classification {
    FOUND("found"),
    MISSING("missing"),
    UNSUPPORTED("unsupported");

    final String wire;

    Classification(String wire) {
      this.wire = wire;
    }
  }

  /** One classified target, ready to serialize. */
  private static final class Result {
    final String target;
    final Classification classification;
    final String className;
    final String methodName;

    Result(String target, Classification classification, String className, String methodName) {
      this.target = target;
      this.classification = classification;
      this.className = className;
      this.methodName = methodName;
    }
  }

  public static void main(String[] args) {
    try {
      // Discover each class at most once, then match methods against its plan.
      // Selecting the whole class (not the method) is what lets us tell a
      // parameterized template (a CONTAINER node) apart from a genuinely missing
      // method: a per-method selector cannot, because a template method takes
      // parameters and fails no-arg method resolution the same way an absent
      // method does.
      Map<String, ClassView> cache = new HashMap<>();
      List<Result> results = new ArrayList<>(args.length);
      for (String target : args) {
        results.add(classify(target, cache));
      }
      System.out.println(toJson(results));
    } catch (Throwable t) {
      // Fail closed: any unexpected discovery failure is a non-zero exit with a
      // diagnostic, never a silently misclassified target.
      System.err.println("resolve-helper: " + t);
      t.printStackTrace();
      System.exit(1);
    }
  }

  /** A discovered class's method → node-type map, or a marker that the class is absent. */
  private static final class ClassView {
    final boolean present;
    final Map<String, TestDescriptor.Type> methodTypes;

    private ClassView(boolean present, Map<String, TestDescriptor.Type> methodTypes) {
      this.present = present;
      this.methodTypes = methodTypes;
    }

    static ClassView absent() {
      return new ClassView(false, Map.of());
    }

    static ClassView present(Map<String, TestDescriptor.Type> methodTypes) {
      return new ClassView(true, methodTypes);
    }
  }

  private static Result classify(String target, Map<String, ClassView> cache) {
    int hash = target.indexOf('#');
    // A bare class name (no `#method`) is not an addressable plain-method target.
    String className = hash >= 0 ? target.substring(0, hash) : target;
    String methodName = hash >= 0 ? target.substring(hash + 1) : "";
    if (hash < 0 || methodName.isEmpty()) {
      return new Result(target, Classification.UNSUPPORTED, className, null);
    }

    ClassView view = cache.computeIfAbsent(className, ResolveHelper::discoverClass);
    if (!view.present) {
      // No such class on the classpath.
      return new Result(target, Classification.MISSING, className, methodName);
    }
    TestDescriptor.Type type = view.methodTypes.get(methodName);
    if (type == null) {
      // The class has no test descriptor for this method name: either no such
      // method, or a method carrying no test annotation → not addressable.
      return new Result(target, Classification.MISSING, className, methodName);
    }
    // A plain @Test is a TEST node; a @ParameterizedTest / @TestFactory is a
    // CONTAINER (a template whose invocations do not exist until execution).
    Classification c =
        type == TestDescriptor.Type.TEST ? Classification.FOUND : Classification.UNSUPPORTED;
    return new Result(target, c, className, methodName);
  }

  /** Discover a class's test tree once, mapping each test method name → its node type. */
  private static ClassView discoverClass(String className) {
    // Probe existence first, WITHOUT initializing (no static initializers run):
    // selectClass resolves lazily, so a missing class would otherwise only fail
    // deep inside discover(). `initialize = false` keeps this an existence check,
    // not a load-and-run — the no-execute guarantee holds even for the probe.
    try {
      Class.forName(className, false, ResolveHelper.class.getClassLoader());
    } catch (ClassNotFoundException e) {
      return ClassView.absent();
    }

    LauncherDiscoveryRequest request =
        LauncherDiscoveryRequestBuilder.request().selectors(selectClass(className)).build();

    Launcher launcher = LauncherFactory.create();
    // discover(), never execute() — no test body runs. This is the guarantee the
    // conformance canary test asserts.
    TestPlan plan = launcher.discover(request);

    Map<String, TestDescriptor.Type> methodTypes = new LinkedHashMap<>();
    Deque<TestIdentifier> queue = new ArrayDeque<>(plan.getRoots());
    while (!queue.isEmpty()) {
      TestIdentifier id = queue.poll();
      TestSource src = id.getSource().orElse(null);
      if (src instanceof MethodSource ms && ms.getClassName().equals(className)) {
        // First node per method wins: a template's own container node, not its
        // (nonexistent-at-discovery) invocation children.
        methodTypes.putIfAbsent(ms.getMethodName(), id.getType());
      }
      queue.addAll(plan.getChildren(id));
    }
    return ClassView.present(methodTypes);
  }

  private static String toJson(List<Result> results) {
    StringBuilder sb = new StringBuilder();
    sb.append("{\"results\":[");
    for (int i = 0; i < results.size(); i++) {
      Result r = results.get(i);
      if (i > 0) {
        sb.append(',');
      }
      sb.append("{\"target\":").append(quote(r.target));
      sb.append(",\"classification\":").append(quote(r.classification.wire));
      if (r.className != null) {
        sb.append(",\"className\":").append(quote(r.className));
      }
      if (r.methodName != null) {
        sb.append(",\"methodName\":").append(quote(r.methodName));
      }
      sb.append('}');
    }
    sb.append("]}");
    return sb.toString();
  }

  private static String quote(String s) {
    StringBuilder sb = new StringBuilder(s.length() + 2);
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        default -> {
          if (c < 0x20) {
            sb.append(String.format("\\u%04x", (int) c));
          } else {
            sb.append(c);
          }
        }
      }
    }
    sb.append('"');
    return sb.toString();
  }

  private ResolveHelper() {}
}
