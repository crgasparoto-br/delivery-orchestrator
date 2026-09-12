# Delivery V2: GitHub-native, risk-adaptive delivery

> **Quick guide only.** `docs/delivery-v2/MASTER_SPEC.md` remains canonical. `config/delivery-v2-requirements.json` is the machine-readable terminal requirement ledger; `docs/delivery-v2/ROADMAP.md` and issue #27 are completed-program history.

## Core idea

> deterministic software controls AI; AI does not control the delivery system.

The normal operational path is now a bounded GitHub workflow, not a sequence reconstructed by a chat:

```text
issue/scope -> provider worker -> managed PR -> exact-head CI
           -> bounded same-PR remediation when needed
           -> risk-required independent audit
           -> bounded same-PR audit remediation when needed
           -> exact-head release gate -> ready/escalated
```

The controller persists state on the managed PR. Material head drift invalidates candidate-bound CI/audit evidence. Attempt ceilings are deterministic and exhausted budgets escalate instead of opening another AI-on-AI loop.

## Scope discovery and risk

FAST remains a reviewed allowlist; unknown paths and sensitive boundaries remain CRITICAL. Requested risk can promote but never downgrade observed risk.

A missing initial changed-path set has two separate meanings:

1. **security classification:** fail closed as CRITICAL;
2. **provider spending:** unresolved `auto` scope does not justify immediately spending the 80-turn / 500-credit CRITICAL material-worker budget.

The dispatch controller first uses supplied paths or deterministic issue path evidence. When it cannot establish any concrete path, it performs **zero provider calls**, keeps security fail-closed, records `needs-scope`, and asks for `changed_paths`. Once concrete scope exists, the normal material budget is selected from observed risk.

Baseline ceilings remain:

- FAST — 20 turns / 100 credits, max 2 implementation attempts;
- STANDARD — 40 turns / 250 credits, max 2 implementation attempts;
- CRITICAL — 80 turns / 500 credits, max 3 implementation attempts and max 2 audit-remediation attempts.

## Same-PR remediation

All compiled provider/risk workers have an initial mode and a remediation mode. Initial mode creates one managed `[delivery-v2] ` PR. Remediation mode receives the controller's structured CI/audit failure packet, works on the exact current PR head, and may write only through constrained `push-to-pull-request-branch` safe output.

A remediation worker cannot create a replacement PR. FAST applies the same file allowlist to both create-PR and remediation-push outputs. Protected-file policy, repository allowlists, explicit provider choice and write-token isolation remain unchanged.

## Adaptive CI and exact-head release

Target repositories continue to own concrete validation commands. The controller observes the target's stable required status and trusted source CI workflow from `config/delivery-v2-controller-targets.json`.

CI and audit evidence is exact-material-SHA-bound. Actionable CI failure becomes the bounded remediation input. External or ambiguous conditions fail closed rather than provoking unrelated code edits.

The release gate becomes ready only when the current remote PR head equals the evaluated material head, the classifier/fingerprint applies to that candidate, the stable required check is terminal green, risk-required audit approves the same candidate, and no blocking finding or budget blocker remains.

## Generic independent audit

`.github/workflows/delivery-v2-audit.yml` is the normal GitHub-native audit workflow. It accepts any configured target repository/PR; it is not gated by the old `DV2-AUDIT-PILOT: critical` marker or issue #27.

The reviewer receives only:

- exact GitHub audit request and check evidence;
- target issue contract;
- PR metadata;
- candidate diff;
- Delivery V2 audit contract.

Product repositories use the compact `docs/delivery-v2/AUDIT_CONTRACT.md` projection to reduce repeated tokens. Changes to the Delivery V2 control plane itself use the full `MASTER_SPEC.md`. Hidden implementer reasoning, historical `.audit/**` / `skills/catalog/**`, generated worker locks and unrelated repository inventory are not reviewer context.

## Observability and token accounting

Every compiled worker retains native `gh-aw` usage artifacts. The normal controller downloads and normalizes those artifacts when available. Audit model usage is normalized into the same delivery record.

Metrics preserve unknown values as `null`; a provider that does not report tokens/credits never becomes a fabricated zero. The final controller artifact includes provider calls, attempts, per-stage usage, CI/audit/end-to-end duration, exact material SHA, change size, evidence references and terminal state.

## Deterministic work deduplication

`Delivery V2 CI` remains the trusted automatic exact-head gate. It runs `verify:v2` for the regular completeness + target-policy checks and `verify:v2:complete` only for the additional strict terminal-completeness assertion, so the target-policy scan is not repeated. The same trusted CI performs the single automatic `gh-aw` compile. `Delivery V2 - Compile gh-aw` is manual preflight only and cannot create a second automatic compile for a PR.

## V1 retirement

V1 remains retired. No active `delivery-request`, `max_cycles`, recursive controller, nested-Skill normal path or mandatory V1 handoff/certificate dependency is reintroduced. Historical `.audit/entregar-issue/**`, `skills/catalog/**` and archived V1 metadata remain traceability-only.

## Validation

```bash
npm test
npm run validate
npm run verify:v2
npm run verify:v2:complete
```

The terminal V2 contract remains protected by the strict completeness gate and `test/v2-retirement.test.mjs`.
