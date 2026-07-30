# Spring Boot hello-world end-to-end fixture

This P3-08 consumer-shaped fixture is intentionally minimal: one Spring Boot
application, one service with a not-yet-approved greeting, and canned artifacts
plus one plain addressable JUnit oracle under `canned/`.

The acceptance harness removes `canned/` from its scratch copy, runs
`crucible init` to install and hash-pin the packaged `java-junit` adapter,
then drives propose through CI verification. The committed canned files are only
FakeSubstrate output; a manual real-substrate run cannot see them.
