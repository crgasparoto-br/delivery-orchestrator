# Delivery V2 — Roadmap

This roadmap records the Delivery V2 implementation sequence and current terminal state. `docs/delivery-v2/MASTER_SPEC.md` is the normative architecture; `config/delivery-v2-requirements.json` is authoritative for requirement status and evidence pointers; issue #27 is the completed rollout history.

The roadmap is intentionally concise. Detailed PR/run/SHA evidence belongs in the requirements manifest and `docs/delivery-v2/evidence/**`, so a new AI context does not need to reread duplicated rollout prose.

## Status model

- `planned` — contract exists; implementation is not complete.
- `implemented` — material implementation exists, but validation/rollout is not terminal.
- `validated` — required validation completed.
- `rolled-out` — validated and active in the intended real repository/environment.

For `requiredForV2Default` requirements, `validated` and `rolled-out` are terminal.

## Completed sequence

| Phase | ID | Requirement | Status |
| --- | --- | --- | --- |
| A | DV2-001 | Deterministic GitHub-native control plane | validated |
| A | DV2-002 | Provider dispatch with no silent fallback | validated |
| A | DV2-003 | Safe-output workers and credential isolation | validated |
| A | DV2-004 | Risk profiles, budgets and bounded provider work | validated |
| A | DV2-005 | Adaptive CI core | validated |
| B | DV2-006 | Fail-closed classifier hardening | validated |
| B | DV2-007 | Versioned classifier distribution | validated |
| C | DV2-008 | GitHub-native independent audit | validated |
| C | DV2-009 | Bounded remediation state machine | validated |
| C | DV2-010 | Exact-head release gate | validated |
| D | DV2-011 | Observability and cost/token accounting | validated |
| E | DV2-012 | `controle_calorias` pilot | rolled-out |
| E | DV2-013 | `training-system` pilot and FAST benchmark | validated |
| F | DV2-014 | V1 and nested-Skill retirement | validated |
| G | DV2-015 | Executable completeness contract | validated |
| D | DV2-016 | Persistent resumable delivery state | validated |

All required DV2-001..DV2-016 requirements are terminal. `npm run verify:v2:complete` is therefore a regression gate, not a pending-rollout signal.

## Sequencing rationale

### Phase A — deterministic foundation

DV2-001 through DV2-005 moved identity, risk, budgets, provider routing and CI-depth decisions out of language-model orchestration and into deterministic code.

### Phase B — safe classification and distribution

DV2-006 made FAST a strict allowlist and preserved unknown/incomplete evidence => CRITICAL. DV2-007 made the classifier distributable to public/private targets through generated, fingerprinted policy packages.

### Phase C — replace V1 audit/remediation ceremony

DV2-008 through DV2-010 replaced nested-Skill handoffs with exact-candidate GitHub evidence, bounded remediation and a deterministic exact-head release gate.

### Phase D — resume and measure

DV2-016 made controller state resumable without chat history. DV2-011 made latency, attempts, provider calls and AI usage measurable. Token/credit data remains explicitly unknown when providers do not expose it; unknown values must never be reconstructed as zero.

### Phase E — real-repository proof

DV2-012 and DV2-013 proved adaptive routing in `controle_calorias` and `training-system`, including materially faster FAST paths while preserving fail-closed CRITICAL handling for sensitive/uncertain changes.

### Phase F — V1 retirement

DV2-014 made V2 the only active normal delivery architecture. Active `delivery-request`, recursive `max_cycles`, nested orchestration Skill and mandatory V1 handoff/certificate paths are retired. Only `.audit/entregar-issue/**` and `skills/catalog/**` are retained as historical traceability and are excluded from normal AI context unless explicitly needed.

### Phase G — program governance

DV2-015 keeps the architecture reconstructable from repository state. The executable completeness gate ensures every manifest ID exists in both the master specification and this roadmap and that terminal requirements have versioned evidence.

## Post-completion hardening

There is no remaining V2 rollout item in the original roadmap. New work is tracked through dedicated issues and must preserve the non-negotiable invariants in `MASTER_SPEC.md`.

Issue #59 is post-completion hardening, not a new architecture phase. It tightens:

- V1-residue detection so retired runtime cannot silently return;
- AI context hygiene so historical/generated artifacts are not explored by default;
- token/credit observability and aggregation;
- canonical `gh-aw` lock publication without duplicate `.generated/gh-aw` snapshots;
- documentation so future sessions consume current state rather than stale rollout instructions.

Hardening does **not** infer a cheaper risk profile from issue prose. If changed-file evidence is missing or uncertain, the classifier remains fail-closed and CRITICAL.

## Evidence and continuation rule

For exact implementation/validation/rollout evidence, read the relevant requirement entry in `config/delivery-v2-requirements.json` and only then open the referenced file/PR/run. Do not preload all historical evidence into an AI context.

A new session should read, in order:

1. `docs/delivery-v2/MASTER_SPEC.md`;
2. `config/delivery-v2-requirements.json`;
3. this roadmap;
4. the current issue/PR.

Issue #27 is historical rollout context and is only needed when a current task depends on that history.
