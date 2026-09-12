# Delivery V2: GitHub-native, risk-adaptive delivery

> **Quick guide only.** The canonical architecture is `docs/delivery-v2/MASTER_SPEC.md`. Machine-readable requirement status is `config/delivery-v2-requirements.json`; implementation order is `docs/delivery-v2/ROADMAP.md`; GitHub issue #27 is the operational umbrella. This file must not be used to override those sources.

## Core idea

Delivery V2 moves orchestration decisions out of the coding model:

> deterministic software controls AI; AI does not control the delivery system.

GitHub owns repository/issue/PR identity, exact SHAs, risk, budgets, checks and release state. AI providers are bounded workers for implementation or independent semantic review.

## Providers

Supported providers:

- `codex`
- `claude`
- `copilot`

Provider+risk resolves to exactly one compiled `gh-aw` worker. Invalid configuration, missing authentication or provider failure fails closed. There is no silent provider fallback.

Agent shell execution receives read access only. Privileged write capability is exposed through constrained safe outputs, not a general write token.

## Risk profiles

### FAST

- strict low-risk allowlist;
- focused/related tests and affected build;
- max 2 implementation attempts;
- 20 AI turns / 100 credits;
- no mandatory LLM audit;
- full regression after merge or scheduled safety net.

### STANDARD

- ordinary application/business/API changes outside critical boundaries;
- affected/non-database tests plus build;
- max 2 implementation attempts;
- 40 AI turns / 250 credits;
- focused independent audit when policy requires it.

### CRITICAL

- database/migrations;
- authentication/authorization/session/security;
- financial/billing;
- shared contracts;
- CI/workflows/config/dependencies/infrastructure;
- privileged integrations;
- unknown or uncertain paths.

CRITICAL keeps the complete repository safety gate, requires independent semantic audit, allows max 3 implementation attempts / 2 audit-remediation attempts, and uses 80 turns / 500 credits.

Requested risk can promote but never downgrade observed risk.

## Adaptive CI

`actions/delivery-v2-risk` and the V2 CI plan provide deterministic risk outputs. Target repositories keep their own build/test commands.

FAST is a strict safe-root allowlist. Static extensions do not grant FAST outside trusted roots. Repository-specific policy can add sensitive boundaries and promote risk, but cannot weaken core CRITICAL invariants. Unknown paths fail closed.

Public target repositories cannot directly consume private reusable workflows from this private repository. The canonical master spec defines generated, fingerprinted vendoring as the official distribution direction.

## Audit and release direction

The normal V2 audit contract is GitHub-native. It binds review to:

- repository + issue/PR;
- base SHA;
- exact material head SHA;
- merge-preview SHA when applicable;
- observed risk and classifier fingerprint;
- required checks/workflow evidence;
- actionable audit findings for that same candidate.

A stale legacy `.audit/entregar-issue/handoff-ready.json` must not be mandatory for a normal V2 delivery.

The exact-head release gate is deterministic. Any material SHA drift invalidates prior CI/audit evidence.

## Current program state

Validated foundation:

- deterministic plan/risk/execution policy;
- provider dispatch;
- safe-output provider workers;
- risk budgets;
- adaptive CI core.

Real pilot evidence:

- `controle_calorias` adaptive migration is merged;
- a real FAST PR completed in about 128 seconds versus an earlier ~1,255-second full baseline.

Still required before V2 becomes the default:

- classifier hardening and target-specific sensitive-boundary policy;
- versioned distribution to public/private repos;
- GitHub-native audit;
- bounded remediation state machine;
- exact-head release gate;
- observability/cost accounting;
- persistent resumable state;
- completed `training-system` FAST pilot;
- V1/nested-Skill retirement.

Run:

```bash
npm run verify:v2
```

to validate the contract structure and show pending required items.

Run:

```bash
npm run verify:v2:complete
```

only as the strict completion/retirement gate; it must remain red while required roadmap items are non-terminal.

## New-context continuation

A new agent/chat should read, in order:

1. `docs/delivery-v2/MASTER_SPEC.md`
2. `config/delivery-v2-requirements.json`
3. `docs/delivery-v2/ROADMAP.md`
4. GitHub issue #27

Then run `npm run verify:v2` and continue the next non-terminal requirement. Conversation history is not a source-of-truth dependency.
