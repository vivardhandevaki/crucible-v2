# Proposal — container-readiness

## Why

The JVM validation path needs an executable proof that a Spring Boot test using
Testcontainers remains an ordinary addressable JUnit oracle.

## What Changes

- Publish application readiness from the Spring context.
- Prove readiness while a real dependency container is running.

## Impact

- Adds one integration-kind oracle executed by the `java-junit` adapter.
- Requires Docker only when the slow integration oracle runs.

## Unspecified

- Production dependency selection and readiness transport are outside this
  fixture; it proves the harness boundary only.

## Seams

- Docker is the external runtime seam used by Testcontainers.
- JUnit remains the sole adapter-facing runner contract.
