# readiness

## ADDED Requirements

### Requirement: Container-backed readiness [REQ-container-readiness-1]

The system SHALL report ready when its Spring context and dependency container
are both running.

#### Scenario: Dependency and context start

- **GIVEN** a reachable Docker service
- **WHEN** the Spring context starts with its dependency container
- **THEN** the integration boundary reports ready
