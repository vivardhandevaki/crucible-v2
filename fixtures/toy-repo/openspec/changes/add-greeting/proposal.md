# Proposal — add-greeting

## Why

The toy repo needs one small, real, user-facing feature so the tracer-bullet
flow (propose → approve → implement → verify) has something concrete to specify,
seal, and judge.

## What Changes

- Add a `greet(name)` function to the `greeting` capability.
- It returns `Hello, <name>!` for any non-empty name.
- It returns `Hello, world!` when no name is given.

## Impact

- New capability: `greeting`.
- New requirements: `REQ-greeting-basic-1`, `REQ-greeting-default-2`.
- Judged by: `ORC-greeting-001`, `ORC-greeting-002`.
