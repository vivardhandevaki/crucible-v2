# Design — add-greeting

Trivial by design: this bundle exists to exercise the harness end to end, not to
pose a real design problem.

## Approach

A pure function `greet(name: string): string` in `src/greeting.ts`. No I/O, no
state, no dependencies.

## Unspecified

- Localization, alternate punctuation, and names containing markup are out of
  scope for this change.
- Trimming/normalizing surrounding whitespace in `name` is left to a later
  change.

## Seams

- `greet` is the single seam; both oracle tests address it directly through the
  stub adapter targets `greeting::returns_hello_for_a_name` and
  `greeting::defaults_to_world_when_empty`.
