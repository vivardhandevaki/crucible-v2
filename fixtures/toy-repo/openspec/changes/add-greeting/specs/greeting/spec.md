# greeting

## ADDED Requirements

### Requirement: Greeting a named user [REQ-greeting-basic-1]

The system SHALL return the greeting `Hello, <name>!` for any non-empty name.

#### Scenario: A name is provided

- **WHEN** `greet("Ada")` is called
- **THEN** it returns `Hello, Ada!`

### Requirement: Default greeting [REQ-greeting-default-2]

The system SHALL greet the world when no name is provided.

#### Scenario: An empty name is given

- **WHEN** `greet("")` is called
- **THEN** it returns `Hello, world!`
