# Oracles — invalid fixture: binding without a requirement

## ORC-greeting-001: Binding omits the requirement field
**Given** the add-greeting change
**When** the linter validates the binding
**Then** a binding with zero requirements is rejected (forbidden by the charter)

```yaml crucible-binding
kind: unit
runner: stub
target: greeting::returns_hello_for_a_name
```
