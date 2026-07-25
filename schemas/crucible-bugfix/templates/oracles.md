# Oracles

<!-- At least one reproduction oracle, marked `reproduces: true`. -->

## ORC-<slug>-001: <reproduction title>

**Given** <the condition that triggers the bug>
**When** <the action>
**Then** <the CORRECT behavior the fix restores>

```yaml crucible-binding
requirement: REQ-<slug>-<seq>
kind: unit
runner: <adapter runner name>
target: <opaque adapter target>
reproduces: true
```
