# ADR 0006 — Keep bounded controller polling; defer event-driven continuation

- Status: Accepted
- Date: 2026-09-13
- Decision owner: Delivery V2 control plane
- Related work: issue #66

## Context

Delivery V2.1 closes the normal deterministic chain from dispatch through CI, bounded remediation, independent audit and exact-head release. The controller currently waits for correlated worker/CI/audit workflow runs with bounded polling while persisting SHA-bound state so a later invocation can resume safely.

Issue #66 evaluates whether replacing those waits with event-triggered continuation would reduce cost/time further.

## Decision

V2.2 keeps **bounded polling inside an active controller invocation** and keeps **persistent deterministic re-entry** for interruptions. It does not convert the normal path to a new `workflow_run`/repository-dispatch state-machine topology in this hardening cycle.

The reason is scope and risk, not preference for polling:

1. polling performs GitHub API reads but does not itself call an AI provider or consume model tokens;
2. provider/token waste identified by issue #66 is addressed directly by scope gating, bounded audit bundles, persistent observability and compile/test deduplication;
3. event-driven continuation changes durable workflow ownership, concurrency, authorization, correlation, timeout and terminal-status behavior across every target repository;
4. introducing that topology while also changing completeness, audit-context and observability contracts would make failures harder to attribute and materially widen the release surface.

## Required invariants while polling remains

- every wait has a bounded timeout;
- workflow dispatch correlation is nonce-bound;
- material SHA drift invalidates stale evidence;
- interruption/re-entry uses persisted state rather than dispatching duplicate provider work;
- recovered provider runs are deduplicated in observability by run ID;
- no polling decision can lower risk or bypass required audit/release checks.

## Revisit trigger

Event-driven continuation should be reconsidered when normalized delivery metrics show runner wait/queue time is a meaningful share of end-to-end latency/cost after provider-call and context reductions are in production. A future change must include adversarial tests for duplicate events, stale SHA events, concurrent delivery correlation, missing events, retry/idempotency and exact-head final status publication.

## Consequences

This decision intentionally leaves some runner idle time in exchange for a smaller and already-proven control surface. It does **not** block later event-driven architecture, and it does not classify current polling as model/token cost. The next optimization decision can be made from DV2-011 metrics rather than assumption.
