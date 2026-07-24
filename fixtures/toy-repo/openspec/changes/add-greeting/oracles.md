# Oracles — add-greeting

## ORC-greeting-001: Greeting names the person
**Given** a non-empty name
**When** `greet(name)` is called
**Then** the result is `Hello, <name>!`

```yaml crucible-binding
requirement: REQ-greeting-basic-1
kind: unit
runner: stub
target: greeting::returns_hello_for_a_name
```

## ORC-greeting-002: Empty name greets the world
**Given** an empty name
**When** `greet("")` is called
**Then** the result is `Hello, world!`

```yaml crucible-binding
requirement: REQ-greeting-default-2
kind: unit
runner: stub
target: greeting::defaults_to_world_when_empty
```
