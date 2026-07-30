# Design — container-readiness

`ReadyApplication` supplies a minimal Spring Boot context and `ReadyState`
publishes the behavior under test. `ContainerReadinessTest` starts the pinned
Testcontainers hello-world image and checks the container and context as one
readiness theme.

The oracle uses `kind: integration` as review metadata while retaining
`runner: junit` and a plain, fully-qualified `Class#method` target. No Spring-
specific adapter exists or is needed.

## Alternatives rejected

- A mocked container would not prove the Testcontainers/CI seam.
- A parameterized or dynamic JUnit test would not be in the addressable subset.
