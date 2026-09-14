# Security and independence model

Delivery V2 treats GitHub and deterministic code as the control plane. AI execution is bounded by explicit provider/risk policy and cannot grant itself additional attempts, credentials, release authority or another provider.

## Deterministic control plane

GitHub owns the durable delivery identity: repository, issue/PR, base/head refs, exact material SHA, CI runs, independent-audit evidence and release state. A material SHA change invalidates candidate-bound CI and audit evidence.

The controller fails closed when risk classification is unknown or sensitive, provider selection cannot be satisfied exactly, required exact-head checks are stale/missing/red, or a required audit is missing/rejected.

## Credential boundary

Normal V2 workers do not receive a generic control-plane write token. Privileged mutations are performed by GitHub Actions or other explicitly bounded publishers after deterministic validation. Provider dispatch has no silent fallback.

Independent semantic review is separated from implementation by fresh context and evidence scope. The reviewer receives the exact candidate/evidence required for review, not implementer hidden reasoning. The current self-hosted audit runtime uses the dedicated auditor OS identity and an isolated Codex home; role execution helpers remain only where the V2 audit runtime requires them.

## Risk and attempt budgets

FAST, STANDARD and CRITICAL policies define finite implementation and audit/remediation budgets. Every review/remediation cycle must consume the corresponding counter. Exhaustion escalates to a human terminal state rather than starting another open-ended AI-on-AI loop.

FAST is an allowlist: unknown paths and authentication/authorization/session/identity/permission boundaries promote to CRITICAL. Repository policy may promote risk or add reviewed safe roots but cannot weaken core invariants.

## Independent audit

CRITICAL release requires an independent result bound to the exact candidate and request evidence. The normal V2 audit is GitHub-native and does not require retired V1 certificates.

Audit context is risk-adaptive at two levels. Diff/material sub-budgets remain 80 KiB aggregate for STANDARD and 160 KiB for CRITICAL. A total pre-model bundle budget also covers bounded issue/PR projections and every model-visible bundle file: STANDARD caps issue body at 24 KiB, PR body at 16 KiB and total bundle at 128 KiB; CRITICAL uses 48 KiB, 32 KiB and 256 KiB. Raw GitHub PR/base/head objects are not sent to the model.

Omitted material never weakens the gate. If issue/PR truncation or total bundle size would make the contract context incomplete, the runtime creates a blocking `audit-context-insufficient` result deterministically and makes **zero audit-provider calls**. Unsupported audit risk profiles also fail closed.

A green source CI run is evidence, not proof that a candidate-modified workflow is semantically safe. Independent review must still assess relevant workflow and code changes when they are part of the candidate.

## Release authority and merge enforcement

Release readiness is computed deterministically from the current material head, effective risk, required checks, audit policy and unresolved findings. The controller publishes the aggregate exact-head result under the target's configured final status.

Merge enforcement is a separate, explicit target-policy fact:

- `native-required-status` is valid only when GitHub branch/ruleset protection demonstrably requires that same final status;
- `controller-status-only` means the exact-head result is published but native merge enforcement is not configured. This mode must include an explicit limitation and cannot be represented as protected.

The currently configured private targets use `controller-status-only`; manual merge is therefore an external governance boundary. A successful AI/audit/controller result never implies native merge protection that GitHub is not actually enforcing.

## Persistent observability

Provider-call and usage accounting is part of controller state. Re-entry continues the same observation record, deduplicates provider runs by run identity and preserves unavailable token/credit values as `null`. A deterministic no-model audit rejection records zero provider calls without synthesizing token usage.

## Retired V1 boundary

The former `delivery-request:` issue queue, `delivery-loop.yml`, `max_cycles` recursion, nested-Skill normal path and mandatory V1 handoff/signing flow are retired. Former V1 snapshot roots are physically absent from the active tree and ignored to prevent accidental regeneration. Active worker prompts refer generically to retired/generated snapshots rather than carrying obsolete V1 path names. Minimal historical provenance is confined to `docs/delivery-v2/history/v1/**` and Git history and is not an active security or orchestration dependency.

Any reintroduction of active V1 entrypoints or snapshot roots is a regression and is blocked by the V2 retirement/physical-cleanup tests.
