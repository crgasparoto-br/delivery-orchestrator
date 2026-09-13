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

STANDARD audit applicability is resolved before any audit-provider call from the effective risk plus the target repository policy. A target with `standardAuditRequired: false` goes directly from exact-head CI success to release evaluation; CRITICAL remains mandatory-audit and cannot be downgraded by that switch.

## Generic independent audit

`.github/workflows/delivery-v2-audit.yml` is the normal GitHub-native audit workflow. It accepts any configured target repository/PR; it is not gated by the old `DV2-AUDIT-PILOT: critical` marker or issue #27.

The reviewer receives a deterministic sanitized bundle containing:

- exact GitHub audit request and check evidence;
- target issue contract;
- PR metadata;
- a bounded prioritized subset of the immutable candidate diff;
- `DIFF_MANIFEST.json`, which binds the full raw diff by SHA-256 and byte count, lists every changed path and records every included/omitted diff block;
- Delivery V2 audit contract;
- bounded exact-SHA material context with prioritized full changed text files plus one-hop direct relative dependencies when resolvable.

Both the diff context and material-context expansion have explicit file, per-file and total-byte ceilings; material context also limits dependency probes. The byte budget is risk-adaptive: STANDARD is capped at 32 KiB of bounded diff plus 48 KiB of material context (80 KiB aggregate), while CRITICAL retains 64 KiB plus 96 KiB (160 KiB aggregate). Missing/unsupported audit risk fails closed, and explicit smaller limits used by focused tests remain valid. The exact base/head SHAs remain the candidate identity, while the diff manifest preserves integrity of the full raw diff without placing all of its bytes in the model context. When either bounded manifest omits material that is genuinely required to support a release-blocking conclusion, the reviewer must fail closed with an `audit-context-insufficient` finding rather than guess or browse the repository. This preserves evidence strength while cutting the STANDARD model-context byte ceiling by 50%.

Product repositories use the compact `docs/delivery-v2/AUDIT_CONTRACT.md` projection to reduce repeated tokens. Changes to the Delivery V2 control plane itself use the full `MASTER_SPEC.md`. Hidden implementer reasoning, generated worker locks and unrelated repository inventory are not reviewer context. The physically retired V1 roots `.audit/entregar-issue/**` and `skills/catalog/**` are ignored and blocked from reintroduction.

## Observability and token accounting

Every compiled worker retains native `gh-aw` usage artifacts. The normal controller downloads and normalizes those artifacts when available. Audit model usage is normalized into the same delivery record.

Metrics preserve unknown values as `null`; a provider that does not report tokens/credits never becomes a fabricated zero. The final controller artifact includes provider calls, attempts, per-stage usage, CI/audit/end-to-end duration, exact material SHA, change size, evidence references and terminal state.

## Deterministic work deduplication

`Delivery V2 CI` remains the trusted automatic exact-head gate. Its aggregate `verify:v2` command runs the strict terminal-completeness verifier exactly once and the target-policy verifier exactly once. `verify:v2:complete` remains available as the focused strict-completeness command, but the CI does not invoke it a second time after `verify:v2`.

Before installing `gh-aw`, the CI compares the worker compilation identity with the trusted base. When worker Markdown sources, generated worker locks/actions lock and compiler-workflow identity are unchanged, the previously trusted base attestation is reused and the `gh-aw` setup/compile steps are skipped. When that identity changes, the same CI performs exactly one strict compile and verifies zero generated drift. `Delivery V2 - Compile gh-aw` remains manual preflight only and cannot create a second automatic compile for a PR.

The CI trigger and syntax checks cover repository scripts by surface (`scripts/**` and generic `*.mjs` loops) rather than by a manually maintained list. A newly added V2 controller/helper script therefore cannot silently bypass the platform gate merely because its filename was not enumerated.

## V1 retirement

V1 remains retired. No active `delivery-request`, `max_cycles`, recursive controller, nested-Skill normal path or mandatory V1 handoff/certificate dependency is reintroduced. The former `.audit/entregar-issue/**` and `skills/catalog/**` snapshot roots have also been physically removed from the working tree and are ignored to prevent accidental regeneration. Minimal historical provenance remains under `docs/delivery-v2/history/v1/**` and in Git history only.

## Validation

```bash
npm test
npm run validate
npm run verify:v2
```

Use `npm run verify:v2:complete` only when the strict completeness verifier is needed in isolation. The terminal V2 contract remains protected by that strict completeness gate and `test/v2-retirement.test.mjs`.
