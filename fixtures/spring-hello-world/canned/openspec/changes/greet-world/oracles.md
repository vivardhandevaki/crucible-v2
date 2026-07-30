# Oracles — greet-world

## ORC-greeting-001: Spring context greets the world

**Given** the Spring Boot application context is running
**When** the greeting service is asked for its greeting
**Then** it returns `Hello, world!`

```yaml crucible-binding
requirement: REQ-greeting-world-1
kind: integration
runner: junit
target: com.crucible.hello.GreetingApplicationTest#greetsWorldFromSpringContext
```
