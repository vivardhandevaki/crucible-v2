# Oracles — container-readiness

## ORC-container-readiness-001: Container-backed context is ready
**Given** a Spring Boot application and an available Docker runtime
**When** the dependency container and application context start
**Then** the integration boundary reports ready

```yaml crucible-binding
requirement: REQ-container-readiness-1
kind: integration
runner: junit
target: com.crucible.conformance.ContainerReadinessTest#containerBackedContextIsReady
```
