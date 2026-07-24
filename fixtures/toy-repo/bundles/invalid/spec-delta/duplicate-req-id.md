# greeting

## ADDED Requirements

### Requirement: Greeting a named user [REQ-greeting-basic-1]

The system SHALL return `Hello, <name>!` for a non-empty name.

#### Scenario: A name is provided

- **WHEN** `greet("Ada")` is called
- **THEN** it returns `Hello, Ada!`

### Requirement: Greeting redux [REQ-greeting-basic-1]

REQ ids are immutable and never reused; this second heading reuses
`REQ-greeting-basic-1` and must be rejected as a duplicate.

#### Scenario: A duplicate id appears

- **WHEN** the extractor sees `REQ-greeting-basic-1` twice
- **THEN** it fails closed
