# greeting

## ADDED Requirements

### Requirement: World greeting [REQ-greeting-world-1]

The Spring-managed greeting service SHALL return `Hello, world!`.

#### Scenario: Application context requests the greeting

- **GIVEN** the Spring Boot application context is running
- **WHEN** the greeting service is asked for its greeting
- **THEN** the response is exactly `Hello, world!`
