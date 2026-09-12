# ADR 0002 — Bounded provider execution with no silent fallback

- Status: Accepted
- Date: 2026-09-12

## Decision

Provider choice is explicit (`codex`, `claude`, or `copilot`) and combined with the risk profile to select one pinned worker. Missing authentication or provider failure fails that attempt; the controller never silently substitutes another provider.

AI work is bounded by implementation/audit attempt ceilings, turns, credits, timeouts, repository allowlists, and safe-output permissions.

## Consequences

- Provider behavior/cost is observable instead of hidden behind fallback.
- A failed provider can be retried only according to explicit policy.
- Exhausted budgets escalate to a human.
- Agent shell execution does not receive a general privileged write token.
