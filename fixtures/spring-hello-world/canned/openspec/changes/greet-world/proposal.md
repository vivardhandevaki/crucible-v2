# Proposal — greet-world

## Why

The minimal Spring Boot validation app needs one user-visible hello-world
behavior proven through Crucible's real JUnit adapter.

## What Changes

- Make the Spring-managed greeting service return `Hello, world!`.
- Add one plain, fully-qualified JUnit oracle target.

## Impact

- Exercises the complete Java consumer loop with no Docker or external service.
- Uses the packaged and hash-pinned `java-junit` adapter.

## Unspecified

- HTTP transport, localization, and named greetings remain outside this fixture.

## Seams

- The Spring application context is the only framework seam.
- JUnit remains the adapter-facing runner contract.
