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

CRITICAL release requires an independent result bound to the exact candidate and request evidence. The normal V2 audit is GitHub-native and does not require legacy `.audit/entregar-issue/handoff-ready.json` certificates.

A green source CI run is evidence, not proof that a candidate-modified workflow is semantically safe. Independent review must still assess relevant workflow and code changes when they are part of the candidate.

## Release authority

Release readiness is computed deterministically from the current material head, effective risk, required checks, audit policy and unresolved findings. Merge authority is separate repository policy; it is never implied by an AI result.

## Retired V1 boundary

The former `delivery-request:` issue queue, `delivery-loop.yml`, `max_cycles` recursion, nested-Skill normal path and mandatory V1 handoff/signing flow are retired. Historical `.audit/entregar-issue/**` and `skills/catalog/**` content may remain for traceability but is not an active security or orchestration dependency.

Any reintroduction of those active V1 entrypoints is a regression and is blocked by `test/v2-retirement.test.mjs`.
