# Delivery V2 — independent audit context

> Compact reviewer projection of `MASTER_SPEC.md`. It reduces repeated LLM context for product-repository audits and never overrides the master specification. Changes to the Delivery V2 control plane itself must be audited against the full `MASTER_SPEC.md`.

## Global invariants

- Deterministic software owns repository/issue/PR identity, risk, provider/model selection, budgets, workflow/check state, structural baseline identity, release transitions, audit applicability, evidence freshness and terminal reason.
- Missing/ambiguous identity, changed-file evidence, classification, required check, provider/model selection, provider authentication, material structural-hygiene evidence or release evidence fails closed; uncertainty never grants a cheaper path.
- Provider/model selection is explicit and GitHub-variable controlled. A failed/missing provider, invalid/unavailable configured model, or missing credential never silently falls back to another provider/model.
- CI, technical-hygiene and audit evidence are valid only for the exact material SHA observed. A material commit invalidates downstream evidence for the older SHA.
- Implementation and audit/remediation loops are bounded. Exhausted budgets escalate to a human instead of opening an AI-on-AI loop.
- Workers have no implicit merge authority. Merge remains repository/human policy unless an explicit versioned policy says otherwise.
- Reuse-First is mandatory before a new material abstraction: bounded discovery prefers `REUSE_EXISTING`, `EXTEND_EXISTING`, `LOCAL_REFACTOR`, then evidence-backed `CREATE_NEW`; insufficient material evidence is `UNKNOWN`.
- Structural decisions use deterministic facts -> deterministic policy -> bounded semantic judgment. Model confidence alone is never release evidence.

## Risk and validation

- FAST is an explicit reviewed allowlist, never the default for unknown paths. Sensitive/auth/security/database/financial/workflow/infrastructure/shared-contract surfaces are CRITICAL.
- Requested risk may promote but may never lower observed risk.
- FAST uses focused/related validation; STANDARD uses affected validation plus build/type/lint; CRITICAL preserves the repository's complete pre-existing PR safety gate.
- Merge-preview compatibility and exact-head validation are distinct. Expensive suites should not be duplicated without a repository-specific reason.
- Material Technical Hygiene `UNKNOWN` promotes FAST to at least STANDARD and remains release-blocking if unresolved. Persistent material `UNKNOWN` after the required reevaluation escalates to human intervention without authorizing candidate mutation or consuming implementation/audit-remediation budgets; any future automatic material correction for a semantic hygiene gap requires an explicit remediation-source and budget contract. Proven Technical Hygiene `BLOCK` remains actionable and follows the bounded implementation-remediation path.

## Technical hygiene evidence

- Initial structural baseline is the deterministic delivery `base_sha`; remediation also records the immediately previous material SHA.
- Technical Hygiene has exactly four principal results: `PASS`, `PASS_WITH_DEBT`, `BLOCK`, `UNKNOWN`.
- Only `PASS` and `PASS_WITH_DEBT` are release-eligible, and only for the exact current material SHA.
- Preexisting debt does not force unrelated refactor when the candidate does not materially worsen it.
- File size, changed-file count and textual similarity are signals, not standalone proof of regression or semantic duplication.
- Material semantic claims require reproducible evidence. If evidence is insufficient, use `UNKNOWN`; if a deterministic fact contradicts a semantic claim, the fact wins.
- A second fallback/workaround for the same behavior requires reproducible root-cause evidence or is blocking.
- The reviewer receives only relevant bounded structural evidence and should not repeat deterministic metrics that are already valid for the exact candidate.

## Independent audit

- FAST has no mandatory LLM audit solely because technical hygiene exists when there is no material semantic ambiguity.
- STANDARD uses focused independent audit only when repository/risk policy requires it; that applicability is resolved before provider dispatch.
- CRITICAL requires independent semantic audit and cannot be disabled by a STANDARD policy switch.
- The audit role resolves its own provider/model GitHub Variables independently from implementation and persists the effective reviewer provider/model in candidate-bound evidence.
- The reviewer receives candidate code/evidence and the contract, not hidden implementer reasoning.
- Candidate context is bounded and exact-SHA: immutable diff plus prioritized full changed text files and resolvable one-hop direct relative dependencies, under deterministic file/byte/probe ceilings.
- Issue and PR inputs are bounded projections rather than raw GitHub API objects. STANDARD allows at most 24 KiB issue body, 16 KiB PR body and 128 KiB total model bundle; CRITICAL allows 48 KiB, 32 KiB and 256 KiB.
- If issue/PR truncation or the total bundle limit would omit material contract context, the runtime must emit a blocking `audit-context-insufficient` result **before model invocation**, with zero audit-provider calls.
- Historical/generated delivery snapshots and unrelated repository inventory are excluded from normal context. If a bounded diff/material omission prevents a supported blocking conclusion, review fails closed as context-insufficient rather than inventing evidence.
- Every finding is candidate-SHA-bound and machine-usable: stable ID, severity, violated contract/requisite, affected surface, concrete failure mode, discriminating/reproducible evidence, remediation mode and release-blocking flag.
- Approval from another material SHA is never reusable.

## Bounded remediation

- Actionable CI failure consumes an implementation/remediation attempt; external infrastructure failure must not trigger unrelated product edits.
- Audit findings are the remediation input unless the remediation diff opens a new risk surface.
- Any remediation material commit invalidates old CI/technical-hygiene/audit evidence and restarts from the minimum safe stage.
- Remediation hygiene compares both against the initial delivery baseline and the immediately previous material SHA, so cumulative degradation cannot hide behind a locally acceptable fix.
- Attempt ceilings come from the effective risk profile and exhaustion escalates with a concise human packet.
- The controller never recursively asks an AI to orchestrate another AI.

## Exact-head release

`ready-for-human-merge` requires current remote head == evaluated material SHA, applicable classifier/fingerprint, required CI terminal green, Technical Hygiene terminal with `PASS` or `PASS_WITH_DEBT` for the same SHA, no material `UNKNOWN`, required independent audit approved for the same SHA, no unresolved blocking finding, no budget/external blocker and no later material commit.

The final `Delivery V2 release` status is release evidence. Whether GitHub natively requires that status for merge is a separate target-policy fact and must not be inferred from a green controller result.

## Security and context hygiene

- Agent execution receives read capability; privileged mutations use constrained safe outputs.
- Protected governance paths and repository/path allowlists remain enforced.
- Provider/model names live in GitHub Variables; credentials live in Secrets.
- Repository policy may tune structural thresholds/tools or promote severity but cannot disable No Structural Regression or reinterpret material `UNKNOWN` as approval.
- Secrets are never echoed and network/tool access is never broadened automatically.
- Retired/generated delivery snapshots, generated locks and unrelated repository inventory are not normal reviewer context.
