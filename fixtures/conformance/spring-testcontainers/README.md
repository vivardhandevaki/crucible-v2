# `spring-testcontainers` — integration-kind JVM fixture

This P3-07 fixture proves the charter's adapter boundary: a Spring Boot test
that starts a real Testcontainers dependency is still an ordinary JUnit target
to `java-junit`. Its Crucible binding records `kind: integration` and addresses
the plain method as:

`com.crucible.conformance.ContainerReadinessTest#containerBackedContextIsReady`

Run it with `mvn test`. It requires JDK 17+, Maven, a reachable Docker daemon,
and registry access for the pinned `testcontainers/helloworld:1.2.0` image.
The shipped JVM CI template provisions the JDK and fails closed at `docker info`
when the Testcontainers runtime is unavailable.

The committed fixture is the green post-implementation state. The P3-07 core
acceptance test copies it privately, removes the bundle/test, flips `ReadyState`
to its red pre-implementation behavior, then drives propose → approve → verify
with the real packaged adapter.
