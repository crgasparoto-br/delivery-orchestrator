# ADR 0004 — GitHub-native audit evidence

- Status: Accepted
- Date: 2026-09-12

## Decision

The normal V2 independent audit consumes exact candidate identity and evidence directly from GitHub/V2 outputs. A legacy `.audit/entregar-issue/handoff-ready.json` is not mandatory for a normal V2 delivery.

CRITICAL review remains independent of the implementation context and is bound to the exact material SHA.

## Consequences

- An inherited/stale V1 certificate cannot block an otherwise valid V2 audit merely because it belongs to another delivery.
- Audit approval is invalid after material SHA drift.
- Findings must be structured/actionable so deterministic remediation can consume them.
- Legacy handoff adapters may exist during migration but are not the V2 source of truth.
