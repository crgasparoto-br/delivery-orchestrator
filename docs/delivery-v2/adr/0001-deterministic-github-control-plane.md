# ADR 0001 — Deterministic GitHub control plane

- Status: Accepted
- Date: 2026-09-12

## Decision

Delivery V2 uses deterministic software and GitHub state as the control plane. AI providers are bounded workers, not orchestrators.

The controller owns identity, risk, provider selection, budgets, attempt counters, CI state, audit applicability, evidence freshness, and terminal state.

## Context

V1 delegated too much orchestration to fresh LLM contexts. That improved role separation but caused repeated rediscovery, high token usage, latency, and difficult-to-reason-about loops.

## Consequences

- GitHub issue/PR/SHA/check state is authoritative.
- A new agent/chat can resume from durable state.
- AI output cannot silently redefine control-plane facts.
- More controller/state-machine code is required, but it is testable and cheaper than repeated reasoning.
