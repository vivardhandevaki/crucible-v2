# Oracles — invalid fixture: unknown binding kind

## ORC-greeting-001: Binding kind is not in the enum
**Given** the add-greeting change
**When** the linter validates `kind`
**Then** `smoke` is rejected (kind ∈ unit|property|contract|integration)

```yaml crucible-binding
requirement: REQ-greeting-basic-1
kind: smoke
runner: stub
target: greeting::returns_hello_for_a_name
```
