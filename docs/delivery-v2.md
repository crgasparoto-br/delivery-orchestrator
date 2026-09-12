# Delivery V2: GitHub-native, risk-adaptive delivery

> **Quick guide only.** The canonical architecture is `docs/delivery-v2/MASTER_SPEC.md`. Machine-readable requirement status is `config/delivery-v2-requirements.json`; sequencing/history is `docs/delivery-v2/ROADMAP.md`; GitHub issue #27 is the completed V2 umbrella. This file must not override those sources.

## Core idea

Delivery V2 moves orchestration decisions out of the coding model:

> deterministic software controls AI; AI does not control the delivery system.

GitHub owns repository/issue/PR identity, exact SHAs, risk, budgets, checks and release state. AI providers are bounded workers for implementation or independent semantic review.

## Providers and bounded execution

Supported providers are `codex`, `claude` and `copilot`. Provider+risk resolves to exactly one compiled `gh-aw` worker. Invalid configuration, missing authentication or provider failure fails closed; there is no silent provider fallback.

Agent shell execution receives read access only. Privileged write capability is exposed through constrained safe outputs, not a general write token.

The baseline AI ceilings remain:

- FAST: 20 turns / 100 credits;
- STANDARD: 40 turns / 250 credits;
- CRITICAL: 80 turns / 500 credits.

These are ceilings, not consumption targets. They should only be tightened from measured production evidence.

## Risk profiles

### FAST

- strict low-risk allowlist;
- focused/related tests and affected build;
- max 2 implementation attempts;
- no mandatory LLM audit;
- full regression after merge or scheduled safety net.

### STANDARD

- ordinary application/business/API changes outside critical boundaries;
- affected/non-database tests plus build;
- max 2 implementation attempts;
- focused independent audit when policy requires it.

### CRITICAL

- database/migrations;
- authentication/authorization/session/security;
- financial/billing;
- shared contracts;
- CI/workflows/config/dependencies/infrastructure;
- privileged integrations;
- unknown, incomplete or uncertain changed-file evidence.

CRITICAL keeps the complete repository safety gate, requires independent semantic audit and allows max 3 implementation attempts / 2 audit-remediation attempts.

Requested risk can promote but never downgrade observed risk. Missing changed-file evidence stays fail-closed; efficiency work must improve deterministic evidence, not guess a cheaper profile from issue prose.

## Adaptive CI and exact-head evidence

`actions/delivery-v2-risk` and the V2 CI plan provide deterministic risk outputs. Target repositories keep their own build/test commands.

FAST is a strict safe-root allowlist. Static extensions do not grant FAST outside trusted roots. Repository-specific policy can add sensitive boundaries and promote risk, but cannot weaken core CRITICAL invariants. Unknown paths fail closed.

Public target repositories consume generated, fingerprinted classifier packages instead of depending directly on private reusable workflows.

Audit and release evidence binds to repository + issue/PR, base SHA, exact material head SHA, merge-preview SHA when applicable, observed risk/classifier fingerprint and required checks. Material head drift invalidates candidate-bound evidence.

## AI context hygiene

Implementation workers start from the target issue and repository instructions and should search only issue-relevant source/test/docs paths. Historical or generated delivery material is excluded from model exploration by default, including `.audit/**`, `skills/catalog/**`, `.generated/**` and compiled `*.lock.yml` files, unless the issue explicitly targets those paths or a deterministic check requires them.

This is a context/token optimization only. It never hides evidence required by CI, audit or a task that actually owns one of those paths.

The canonical compiled `gh-aw` worker locks live in `.github/workflows/*.lock.yml` plus `.github/aw/actions-lock.json`. Duplicate `.generated/gh-aw` snapshots are not part of the active architecture.

## Observability and cost accounting

Delivery metrics preserve provider usage when available:

- AI turns and credits;
- input, output and total tokens;
- optional per-stage AI usage;
- provider cost;
- provider calls and attempts;
- CI/audit/end-to-end duration;
- change size, terminal reason and escalation.

Every compiled implementation worker must retain the native `gh-aw` usage payloads (`/tmp/gh-aw/usage/agent_usage.json` and `.jsonl`) in its generated contract. Those artifacts are the raw provider telemetry source for real token/AI-credit analysis; the repository regression suite checks their presence across all provider/risk workers so a compiler upgrade cannot silently remove cost visibility.

Summaries aggregate usage by repository/risk/provider and by stage when stage telemetry exists. Missing token/credit/cost telemetry remains unknown/null; it is never silently converted to zero. This distinction is required before using the data to tune worker budgets.

The first measured FAST pilot in `controle_calorias` observed approximately 128 seconds versus an earlier approximately 1,255-second full baseline (~89.8% reduction, ~9.8x faster). This is evidence, not a universal SLA.

## Current program state

Delivery V2 is the default and only active delivery architecture. The required DV2-001..DV2-016 program reached terminal status under the completion contract, and V1 active orchestration was retired under DV2-014.

Post-completion hardening keeps the following invariants continuously enforced:

- no active `delivery-request`/`max_cycles`/recursive V1 runtime returns;
- historical `.audit/entregar-issue/**` and `skills/catalog/**` material remains traceability-only;
- active executable surfaces do not depend on those historical snapshot trees;
- compiled workers stay synchronized with their Markdown sources and retain raw usage telemetry;
- token/credit telemetry remains explicit and comparable;
- risk classification remains fail-closed.

Run:

```bash
npm test
npm run validate
npm run verify:v2
npm run verify:v2:complete
```

`verify:v2:complete` is now a regression guard for the terminal V2 contract rather than a pending rollout gate.

## New-context continuation

A new agent/chat should read, in order:

1. `docs/delivery-v2/MASTER_SPEC.md`
2. `config/delivery-v2-requirements.json`
3. `docs/delivery-v2/ROADMAP.md`
4. issue #27 for completed-program history and the current issue/PR for new work

Conversation history is optional context, never a correctness dependency. Historical V1 artifacts must not be used to reconstruct current orchestration state.
