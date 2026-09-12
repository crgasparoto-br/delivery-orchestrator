# ADR 0003 — Risk-adaptive CI and audit

- Status: Accepted
- Date: 2026-09-12

## Decision

Delivery V2 uses deterministic FAST, STANDARD, and CRITICAL risk profiles.

FAST is a strict safe allowlist and receives focused CI with no mandatory LLM audit. STANDARD receives broad affected validation and focused audit when policy requires it. CRITICAL preserves the full safety gate and requires independent semantic audit.

Unknown/uncertain paths fail closed to CRITICAL. Requested risk may promote but never downgrade observed risk.

## Consequences

- Small changes can complete quickly without deleting the full regression safety net.
- Classification becomes a security boundary and requires adversarial tests.
- Sensitive entrypoints must be modeled by repository policy, not only filename keywords.
- Full post-merge/scheduled regression remains part of FAST/STANDARD safety.
