# Delivery V2 — independent audit context

> Compact reviewer projection of `MASTER_SPEC.md`. It reduces repeated LLM context for product-repository audits and never overrides the master specification. Changes to the Delivery V2 control plane itself must be audited against the full `MASTER_SPEC.md`.

## Global invariants

- Deterministic software owns repository/issue/PR identity, risk, provider selection, budgets, workflow/check state, release transitions, audit applicability, evidence freshness and terminal reason.
- Missing/ambiguous identity, changed-file evidence, classification, required check, provider authentication or release evidence fails closed; uncertainty never grants a cheaper path.
- Provider selection is explicit. A failed/missing provider never silently falls back to another provider.
- CI and audit evidence are valid only for the exact material SHA observed. A material commit invalidates downstream evidence for the older SHA.
- Implementation and audit/remediation loops are bounded. Exhausted budgets escalate to a human instead of opening an AI-on-AI loop.
- Workers have no implicit merge authority. Merge remains repository/human policy unless an explicit versioned policy says otherwise.

## Risk and validation

- FAST is an explicit reviewed allowlist, never the default for unknown paths. Sensitive/auth/security/database/financial/workflow/infrastructure/shared-contract surfaces are CRITICAL.
- Requested risk may promote but may never lower observed risk.
- FAST uses focused/related validation; STANDARD uses affected validation plus build/type/lint; CRITICAL preserves the repository's complete pre-existing PR safety gate.
- Merge-preview compatibility and exact-head validation are distinct. Expensive suites should not be duplicated without a repository-specific reason.

## Independent audit

- FAST has no mandatory LLM audit.
- STANDARD uses focused independent audit only when repository/risk policy requires it; that applicability is resolved before provider dispatch.
- CRITICAL requires independent semantic audit and cannot be disabled by a STANDARD policy switch.
- The reviewer receives candidate code/evidence and the contract, not hidden implementer reasoning.
- Candidate context is bounded and exact-SHA: immutable diff plus prioritized full changed text files and resolvable one-hop direct relative dependencies, under deterministic file/byte/probe ceilings.
- Historical/generated delivery artifacts and unrelated repository inventory are excluded from normal context. If a bounded omission prevents a supported blocking conclusion, review fails closed as context-insufficient rather than inventing evidence.
- Every finding is candidate-SHA-bound and machine-usable: stable ID, severity, violated contract/requisite, affected surface, concrete failure mode, discriminating/reproducible evidence, remediation mode and release-blocking flag.
- Approval from another material SHA is never reusable.

## Bounded remediation

- Actionable CI failure consumes an implementation/remediation attempt; external infrastructure failure must not trigger unrelated product edits.
- Audit findings are the remediation input unless the remediation diff opens a new risk surface.
- Any remediation material commit invalidates old CI/audit evidence and restarts from the minimum safe stage.
- Attempt ceilings come from the effective risk profile and exhaustion escalates with a concise human packet.
- The controller never recursively asks an AI to orchestrate another AI.

## Exact-head release

`ready-for-human-merge` requires current remote head == evaluated material SHA, applicable classifier/fingerprint, required CI terminal green, required independent audit approved for the same SHA, no unresolved blocking finding, no budget/external blocker and no later material commit.

## Security and context hygiene

- Agent execution receives read capability; privileged mutations use constrained safe outputs.
- Protected governance paths and repository/path allowlists remain enforced.
- Secrets are never echoed and network/tool access is never broadened automatically.
- Historical `.audit/**`, `skills/catalog/**`, generated locks and unrelated repository inventory are not normal reviewer context.
