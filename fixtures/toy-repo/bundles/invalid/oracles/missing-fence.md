# Oracles — invalid fixture: missing binding fence

## ORC-greeting-001: No crucible-binding block follows
**Given** the add-greeting change
**When** the linter looks for exactly one binding fence
**Then** it finds none before the next heading and rejects this oracle

## ORC-greeting-002: A second, well-formed oracle
**Given** the add-greeting change
**Then** the missing fence above is the isolated defect

```yaml crucible-binding
requirement: REQ-greeting-default-2
kind: unit
runner: stub
target: greeting::defaults_to_world_when_empty
```
