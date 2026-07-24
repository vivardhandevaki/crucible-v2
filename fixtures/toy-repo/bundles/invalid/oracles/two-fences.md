# Oracles — invalid fixture: two binding fences

## ORC-greeting-001: Two crucible-binding blocks
**Given** the add-greeting change
**When** the linter requires exactly one binding fence
**Then** two fences before the next heading is a structural error

```yaml crucible-binding
requirement: REQ-greeting-basic-1
kind: unit
runner: stub
target: greeting::returns_hello_for_a_name
```

```yaml crucible-binding
requirement: REQ-greeting-default-2
kind: unit
runner: stub
target: greeting::defaults_to_world_when_empty
```
