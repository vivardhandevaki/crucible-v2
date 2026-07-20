# greeting

## ADDED Requirements

### Requirement: Greeting a named user [REQ-greeting-basic]

The system SHALL return `Hello, <name>!` for a non-empty name.
The bracketed id omits the trailing `-<n>`, so it fails `[REQ-[a-z0-9-]+-\d+]`.

#### Scenario: A name is provided

- **WHEN** `greet("Ada")` is called
- **THEN** it returns `Hello, Ada!`
