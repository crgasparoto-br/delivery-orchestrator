# Delivery V2 — Roadmap

This roadmap is the implementation sequence for the canonical contract in `MASTER_SPEC.md`. Requirement status is authoritative in `config/delivery-v2-requirements.json`; this document explains ordering, dependencies, and exit criteria. Operational tracking lives in GitHub issue #27.

## Status legend

- `planned` — contract exists; implementation is not complete.
- `implemented` — material implementation exists, but validation/rollout is not terminal.
- `validated` — implementation passed its required deterministic/semantic validation.
- `rolled-out` — validated and active in the intended real repository/environment.

A requirement marked `requiredForV2Default` is complete only in `validated` or `rolled-out`.

## Phase A — deterministic foundation

| ID | Requirement | Current status | Exit condition |
| --- | --- | --- | --- |
| DV2-001 | Deterministic GitHub-native control plane | validated | Planner/risk/execution policy are deterministic and tested. |
| DV2-002 | Provider dispatch with no silent fallback | validated | Provider+risk maps to one worker; auth/dispatch failures fail closed. |
| DV2-003 | Safe-output workers and credential isolation | validated | Agent shell lacks privileged write token and writes are constrained. |
| DV2-004 | Risk profiles, budgets and bounded provider work | validated | FAST/STANDARD/CRITICAL budgets are executable and tested. |
| DV2-005 | Adaptive CI core | validated | Core classifier/CI plan is deterministic and produces reusable outputs. |

No Phase A work should be reopened unless a later finding proves a systemic defect.

## Phase B — make classification safe and distributable

### DV2-006 — Fail-closed classifier hardening

Status: **validated**.

Required work:

- model FAST as a strict safe allowlist;
- evaluate always-CRITICAL/sensitive boundaries before FAST;
- support real auth/access/session/identity/permission entrypoints whose filenames may not contain obvious keywords;
- remove any global extension rule that can grant FAST outside trusted roots;
- preserve unknown-path => CRITICAL;
- prove requested risk can promote but never downgrade;
- add adversarial tests based on real and sibling cases from the `training-system` audit.

Exit condition: the core policy and target-repository policy contract make the audit cases impossible by construction.

### DV2-007 — Versioned classifier distribution

Status: **validated**.

Depends on DV2-006.

Official direction: generated vendoring from the private orchestrator.

Required work:

- target policy schema;
- generator/export command;
- generated runtime/policy lock;
- source version + fingerprint;
- repository-specific promotion/safe-root config;
- verifier that detects drift;
- orchestrator-driven update PR flow;
- migrate `controle_calorias` and `training-system` away from hand-maintained classifier copies.

Terminal validation evidence:

- orchestrator generator/distribution merged by PR #31;
- target-specific `RoleGuard` promotion preserved by PR #32;
- `controle_calorias` PR #1069 merged into `develop` as `6507bdc0dc14ebc744de75393e5dc0c6bda8b112`;
- `training-system` PR #435 merged into `develop` as `0fba4d2870e087775433b844e22f04c0daa84bcf`;
- both merged packages are pinned to orchestrator commit `1d6185de16e3a30378a810132bb4e3cf9483f98c`;
- both locks carry canonical classifier fingerprint `35914f89844e0a6c35a436af1a1856e6a2b37ab7f5e0f3d3c1749e7a89d3ad24`.

Exit condition: public and private target repositories consume traceable generated policy without directly requiring private reusable actions. **Satisfied.**

## Phase C — replace V1 audit/remediation ceremony

### DV2-008 — GitHub-native independent audit

Status: **implemented; validation pending CRITICAL pilot**.

Depends on DV2-006 and the exact evidence contract.

Required work:

- define V2 audit input schema from GitHub identity/checks/classifier evidence;
- implement FAST/STANDARD/CRITICAL applicability;
- make CRITICAL review independent of implementation context;
- emit stable actionable finding objects;
- bind audit to exact material SHA;
- ignore inherited/stale V1 handoff as a release blocker when V2 evidence is valid;
- keep legacy audit adapter only during migration.

Exit condition: a CRITICAL pilot can be approved/rejected on its actual candidate without requiring `.audit/entregar-issue/handoff-ready.json`.

### DV2-009 — Bounded remediation state machine

Status: **implemented; validation pending bounded failure exercise**.

Depends on DV2-008 findings contract.

Required work:

- deterministic transition table;
- attempt accounting by risk;
- CI-failure classification (`actionable`, `external`, `preexisting`);
- targeted audit remediation;
- invalidation on material SHA drift;
- escalation packet when budgets are exhausted;
- no recursive/nested orchestration Skills.

Exit condition: every loop either reaches a terminal state or deterministic escalation within configured budgets.

### DV2-010 — Exact-head release gate

Status: **implemented; validation pending live exact-head release exercise**.

Depends on DV2-008 and DV2-009.

Required work:

- stable final required status;
- exact remote head check;
- risk/profile/fingerprint binding;
- required CI aggregation;
- audit aggregation by risk;
- unresolved finding check;
- automatic invalidation on SHA drift;
- explicit merge-policy decision.

Exit condition: `ready-for-human-merge` can be derived entirely from current GitHub/V2 evidence.

## Phase D — make the controller resumable and measurable

### DV2-016 — Persistent resumable delivery state

Required work:

- durable state schema;
- idempotent transitions;
- attempt counters;
- evidence/check references;
- remote identity reconciliation;
- resume command/API;
- stale-state protection.

Exit condition: another process/chat can resume the same PR using repository/GitHub state only.

### DV2-011 — Observability and cost accounting

Can progress in parallel with DV2-016.

Required work:

- normalized delivery metrics;
- provider calls/turns/credits/cost where available;
- CI queue/run duration;
- audit/remediation duration;
- end-to-end duration;
- terminal reason;
- benchmark reporting by risk/repository/provider.

Exit condition: V2 performance/cost comparisons no longer depend on manual timing from chat transcripts.

## Phase E — prove the design in real repositories

### DV2-012 — `controle_calorias`

Status: **rolled-out**.

Existing evidence:

- adaptive CI migration merged;
- full post-merge regression preserved;
- real FAST accessibility change executed related tests instead of the full 24-shard suite;
- observed FAST runtime ~128 seconds versus ~1,255-second historical full baseline.

Follow-up after DV2-007: completed. PR #1069 is merged in `develop` with the generated versioned package active.

### DV2-013 — `training-system`

Status: **implemented, not rolled out**.

Required closure:

- record the disposition of any remaining independent-audit findings from PR #435 against the merged candidate;
- run one real low-risk UI FAST PR;
- record duration and skipped/executed gates.

Generated classifier package migration is complete in merged PR #435.

Do not mark rolled-out based only on a CRITICAL migration PR.

## Phase F — retire the old model

### DV2-014 — V1 and nested-Skill retirement

Depends on DV2-006 through DV2-013 and DV2-016 being terminal.

Required work:

- make V2 the default entrypoint;
- disable/remove legacy active `delivery-request` loops;
- remove normal-path nested Skill orchestration;
- remove mandatory V1 handoff/certificate dependency;
- migrate/close queued legacy work;
- remove dead loop/max-cycle code;
- update README/security/capabilities/docs;
- retain history only where it has traceability value.

Exit condition: no normal delivery path needs V1 to complete safely.

## Phase G — keep the program itself governed

### DV2-015 — Canonical master specification and executable completeness gate

Status: **validated**.

Required work:

- canonical `MASTER_SPEC.md`;
- this roadmap;
- machine-readable requirements manifest;
- structural verifier;
- CI integration;
- umbrella issue #27 aligned with stable IDs.

Exit condition: `npm run verify:v2` is green in CI and a new context can reconstruct all architectural decisions from repository state.

## Release-to-default checklist

Delivery V2 must not be declared complete until `node scripts/verify-delivery-v2-completeness.mjs --require-complete` exits successfully.

That means every required item below is terminal:

- DV2-001
- DV2-002
- DV2-003
- DV2-004
- DV2-005
- DV2-006
- DV2-007
- DV2-008
- DV2-009
- DV2-010
- DV2-011
- DV2-012
- DV2-013
- DV2-014
- DV2-015
- DV2-016

## Next implementation order

Unless a production incident changes priority, continue in this order:

1. DV2-016
2. DV2-011
3. validate DV2-008 with a real CRITICAL pilot
4. validate DV2-009 with bounded CI/audit remediation evidence
5. validate DV2-010 with a live exact-head release exercise
6. close DV2-013
7. DV2-014

Every PR should name the `DV2-*` IDs it advances and update the manifest only when the evidence justifies the new status.
