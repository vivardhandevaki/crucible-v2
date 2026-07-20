# Oracles — invalid fixture: bad oracle id

## ORC-greeting-1: Oracle sequence is not three digits
**Given** the add-greeting change
**When** the linter parses this heading
**Then** the id fails `^## (ORC-[a-z0-9-]+-\d{3}):` (seq must be exactly 3 digits) and is rejected

```yaml crucible-binding
requirement: REQ-greeting-basic-1
kind: unit
runner: stub
target: greeting::returns_hello_for_a_name
```
