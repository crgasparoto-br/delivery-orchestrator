# Delivery V2: GitHub-native, risk-adaptive delivery

> **Quick guide only.** `docs/delivery-v2/MASTER_SPEC.md` remains canonical. `config/delivery-v2-requirements.json` is the machine-readable terminal requirement ledger; `docs/delivery-v2/ROADMAP.md` and issue #27 are completed-program history.

## Core idea

> deterministic software controls AI; AI does not control the delivery system.

The normal operational path is now a bounded GitHub workflow, not a sequence reconstructed by a chat:

```text
issue/scope -> provider/model worker -> managed PR -> exact-head CI
           -> bounded same-PR remediation when needed
           -> risk-required independent audit
           -> bounded same-PR audit remediation when needed
           -> exact-head release gate -> ready/escalated
```

The controller persists state on the managed PR. Material head drift invalidates candidate-bound CI/audit evidence. Attempt ceilings are deterministic and exhausted budgets escalate instead of opening another AI-on-AI loop.

## AI provider/model configuration

Implementation/remediation and independent-audit AI choices are configured through GitHub Actions Variables in `delivery-orchestrator`, not selected manually on every dispatch. The controller determines effective risk first, then resolves the applicable role/risk provider and model.

Precedence is risk-specific role variable → general role variable → concrete versioned default. Supported providers are `codex`, `claude`, and `copilot`. There is no silent provider/model fallback: invalid/unavailable model, failed provider invocation, or missing authentication blocks the attempt rather than substituting another AI.

The full variable matrix, current concrete defaults, secrets mapping, and examples are documented in `docs/delivery-v2/AI_CONFIGURATION.md`.

## Scope discovery and risk

FAST remains a reviewed allowlist; unknown paths and sensitive boundaries remain CRITICAL. Requested risk can promote but never downgrade observed risk.

A missing initial changed-path set has two separate meanings:

1. **security classification:** fail closed as CRITICAL;
2. **provider spending:** unresolved `auto` scope does not justify immediately spending the 80-turn / 500-credit CRITICAL material-worker budget.

The dispatch controller first uses supplied paths or deterministic issue path evidence. When it cannot establish any concrete path, it performs **zero provider calls**, keeps security fail-closed, records `needs-scope`, and asks for `changed_paths`. Once concrete scope exists, the normal material budget is selected from observed risk.

When `changed_paths` is supplied explicitly, it is also a **hard material-output boundary**, not only a classification hint. The initial reservation persists a trusted binding between repository, issue number, SHA-256 of the issue title/body, and the normalized explicit paths. Before any `create-pull-request` or remediation push safe output can run, the `gh-aw` threat-detection job validates the staged `aw.patch` against that binding. Any changed path outside the explicit envelope, or any intervening mutation of the bound issue contract, fails closed before write-capable safe outputs execute. Deliveries without an explicit path envelope still bind the issue contract; legacy remediation without a stored binding is conservatively limited to paths already present in the managed PR.

Baseline ceilings remain:

- FAST — 20 turns / 100 credits, max 2 implementation attempts;
- STANDARD — 40 turns / 250 credits, max 2 implementation attempts;
- CRITICAL — 80 turns / 500 credits, max 3 implementation attempts and max 2 audit-remediation attempts.

FAST, STANDARD and CRITICAL operational limits may be overridden with the repository variables `DELIVERY_<PROFILE>_MAX_AI_CREDITS`, `DELIVERY_<PROFILE>_MAX_AI_TURNS` and `DELIVERY_<PROFILE>_MAX_IMPLEMENTATION_ATTEMPTS`. Removing an override restores the versioned baseline.

## Same-PR remediation

All compiled provider/risk workers have an initial mode and a remediation mode. Initial mode creates one managed `[delivery-v2] ` PR. Remediation mode receives the controller's structured CI/audit failure packet, works on the exact current PR head, and may write only through constrained `push-to-pull-request-branch` safe output.

A remediation worker cannot create a replacement PR. FAST applies the same file allowlist to both create-PR and remediation-push outputs. The trusted scope detector runs for Copilot, Codex and Claude at FAST, STANDARD and CRITICAL before either safe-output write path. Protected-file policy, repository allowlists, resolved provider/model policy and write-token isolation remain unchanged.

## Adaptive CI and exact-head release

Target repositories continue to own concrete validation commands. The controller observes the target's stable required status and trusted source CI workflow from `config/delivery-v2-controller-targets.json`.

CI and audit evidence is exact-material-SHA-bound. Actionable CI failure becomes the bounded remediation input. External or ambiguous conditions fail closed rather than provoking unrelated code edits.

The release gate becomes ready only when the current remote PR head equals the evaluated material head, the classifier/fingerprint applies to that candidate, the stable required check is terminal green, risk-required audit approves the same candidate, and no blocking finding or budget blocker remains.

The aggregate exact-head result is published as `Delivery V2 release`. Target policy now records whether GitHub **natively requires** that status (`native-required-status`) or whether it is only published by the controller (`controller-status-only`). A controller-only target must state the limitation explicitly and cannot claim branch/ruleset enforcement that is not actually configured. Human/manual merge remains the governance boundary in that mode.

STANDARD audit applicability is resolved before any audit-provider call from the effective risk plus the target repository policy. A target with `standardAuditRequired: false` goes directly from exact-head CI success to release evaluation; CRITICAL remains mandatory-audit and cannot be downgraded by that switch.

## Generic independent audit

`.github/workflows/delivery-v2-audit.yml` is the normal GitHub-native audit workflow. It accepts any configured target repository/PR; it is not gated by an old pilot marker or issue #27. Its provider/model is resolved independently from implementation through the audit GitHub Variables, and its runtime remains isolated from the implementer context.

The reviewer receives a deterministic sanitized bundle containing:

- exact GitHub audit request and check evidence;
- bounded target issue contract;
- bounded PR identity/description projection rather than raw GitHub API objects;
- a bounded prioritized subset of the immutable candidate diff;
- `DIFF_MANIFEST.json`, which binds the full raw diff by SHA-256 and byte count, lists every changed path and records every included/omitted diff block;
- Delivery V2 audit contract;
- bounded exact-SHA material context with prioritized full changed text files plus one-hop direct relative dependencies when resolvable.

Diff/material sub-budgets remain risk-adaptive: STANDARD uses 32 KiB diff + 48 KiB material context, while CRITICAL uses 64 KiB + 96 KiB. A second **total bundle** gate now accounts for the issue/PR projections and all model files before a provider call: STANDARD caps issue body at 24 KiB, PR body at 16 KiB and total bundle at 128 KiB; CRITICAL caps them at 48 KiB, 32 KiB and 256 KiB. If an issue/PR body would be truncated or the total budget is exceeded, the runtime emits deterministic `audit-context-insufficient` evidence and performs **zero audit-provider calls**.

Product repositories use the compact `docs/delivery-v2/AUDIT_CONTRACT.md` projection to reduce repeated tokens. Changes to the Delivery V2 control plane itself use the full `MASTER_SPEC.md`. Hidden implementer reasoning, generated worker locks and unrelated repository inventory are not reviewer context.

Audit artifacts persist the reviewer provider/model used for that candidate. Compiled implementation workflows expose their resolved model in GitHub Actions outputs, so later changes to Variables do not rewrite historical execution identity.

## Observability and token accounting

Every compiled worker retains native `gh-aw` usage artifacts. The normal controller downloads and normalizes those artifacts when available. Audit model usage is normalized into the same delivery record.

The same observability accumulator is persisted with controller state and reused after re-entry. Provider runs are deduplicated by run ID, so recovering an in-flight worker/audit cannot charge the same call twice. Metrics preserve unknown values as `null`; a provider that does not report tokens/credits never becomes a fabricated zero. A deterministic audit-context rejection has a known provider-call count of zero without inventing token usage.

Existing-PR identity does not depend on the `[delivery-v2]` title. Re-entry discovers explicit closing references across all open PRs and requires a single candidate, the configured trusted author **and** a trusted association, the target repository on both base/head, the expected base branch, a head branch and exact base/head SHAs. Forks, conflicting closing targets, missing identity and multiple linked PRs block re-entry rather than falling through to a fresh implementation. The resume path applies the same identity check again.

A legacy title with trusted canonical state resumes that same PR and records `controller.adoption.type=legacy-adopted` with the observed identity and state/controller provenance. Without canonical state, a trusted legacy PR receives a separate `delivery-v2-legacy-adoption` checkpoint. Unknown classifier, risk, audit and historical counters remain `null`; proven bootstrap implementation attempts retain their count and comment provenance. This checkpoint cannot be passed off as a complete operational state or release approval.

The dispatcher checks out the adopted PR's immutable head and routes `resume_pr` to deterministic `post-write-refreeze`, excluding initial reservation and implementation. A trusted, exact-identity `delivery-v2-audit-continuation` JSON comment must explicitly request `handoff-stale`, `post-write-refreeze`, `requires_refreeze=true`, `next_phase=finalize-after-ci`, and authorize exact-head CI reuse. Classification uses the canonical classifier and observed changed paths. CI reuse requires a terminal successful run/check for the current SHA, configured repository/workflow, branch and matching GitHub Actions check suite. Head/base drift invalidates continuation and downstream evidence, including a final recheck before persistence. See [the continuation contract](delivery-v2/LEGACY_ADOPTION.md).

Successful refreeze persists the same PR/head, real classifier and CI references with phase `post-write-refreeze`; it does not itself grant release readiness. Unknown historical audit/remediation counters remain `null`. The controller can then reserve a separate bounded post-adoption audit attempt, persist its nonce/run/evidence for idempotent re-entry, and create a new operational epoch whose counters describe only work performed after adoption. The first audit represents an unknown legacy material producer explicitly as `legacy-unknown` rather than inventing provider/run/attempt provenance. Rejection follows normal bounded same-PR V2 remediation; approval still requires same-head Technical Hygiene and the exact-head release gate. Evidence-only hygiene collection must not mutate the PR. The legacy checkpoint remains separate historical provenance throughout.

For the historical issue #105 / PR #122 snapshot, PR discovery already succeeds on main after #146. The remaining persisted `escalated` state with `implementation-budget-exhausted-after-audit` is not automatically migrated by #146: its fix changes future audit-remediation transitions. Identity recovery does not reset that terminal state or erase the four rejected-audit findings. The existing PR can be reused, but that historical-state recovery and fresh required gates remain prerequisites to automated continuation/release.

The final controller artifact includes provider calls, attempts, per-stage usage, CI/audit/end-to-end duration, exact material SHA, change size, evidence references and terminal state. Legacy state created before persistent observability is reported explicitly rather than backfilled from guesses.

## Deterministic work deduplication

`Delivery V2 CI` remains the trusted automatic exact-head gate. Its aggregate `verify:v2` command runs the strict terminal-completeness verifier exactly once and the target-policy verifier exactly once. `verify:v2:complete` remains available as the focused strict-completeness command, but the CI does not invoke it a second time after `verify:v2`.

Completeness is no longer a single global set-membership check. A requirement can declare `minimumCompletionStatus`; the default is `validated`, while DV2-012 and DV2-013 require `rolled-out`. This prevents a real-rollout requirement from being declared complete while merely validated.

Before installing `gh-aw`, the CI compares the worker compilation identity with the trusted base. When worker Markdown sources, generated worker locks/actions lock and compiler-workflow identity are unchanged, the previously trusted base attestation is reused and the `gh-aw` setup/compile steps are skipped. When that identity changes, the same CI performs exactly one strict compile and verifies zero generated drift. `Delivery V2 - Compile gh-aw` remains manual preflight only and cannot create a second automatic compile for a PR.

The CI trigger and syntax checks cover repository scripts by surface (`scripts/**` and generic `*.mjs` loops) rather than by a manually maintained list. A newly added V2 controller/helper script therefore cannot silently bypass the platform gate merely because its filename was not enumerated.

## Controller continuation model

V2.2 keeps bounded polling inside a controller invocation and uses persisted state/re-entry for interruption recovery. Converting every CI/audit transition into an event-triggered continuation would change workflow ownership, concurrency and failure semantics across repositories; that is intentionally deferred to a separate architectural change. Polling itself performs no model calls, so this hardening first removes token/provider waste without silently expanding orchestration risk. See ADR `docs/delivery-v2/adr/0006-bounded-polling-before-event-driven.md`.

## V1 retirement

V1 remains retired. No active `delivery-request`, `max_cycles`, recursive controller, nested-Skill normal path or mandatory V1 handoff/certificate dependency is reintroduced. Former V1 snapshot roots have been physically removed from the working tree and are ignored to prevent accidental regeneration. Active worker prompts refer generically to retired/generated snapshots instead of carrying obsolete V1 path names. Minimal historical provenance remains under `docs/delivery-v2/history/v1/**` and in Git history only.

## Validation

```bash
npm test
npm run validate
npm run verify:v2
```

Use `npm run verify:v2:complete` only when the strict completeness verifier is needed in isolation. The terminal V2 contract remains protected by that strict completeness gate and the V1-retirement regression tests.
