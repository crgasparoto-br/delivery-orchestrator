# Delivery V2 — Master Specification

> **Canonical architecture contract.** This document is the normative source of truth for the Delivery V2 design. `config/delivery-v2-requirements.json` is the machine-readable status projection of this contract; `docs/delivery-v2/ROADMAP.md` is the implementation sequence; GitHub issue #27 is the operational tracking surface. If a chat transcript, issue comment, older document, or implementation detail conflicts with this specification, this specification wins until it is deliberately amended in-repository.

## 1. Why Delivery V2 exists

Delivery V1 proved that AI agents can implement and audit software changes, but its orchestration model is too expensive and too slow for routine engineering. The problematic shape is approximately:

```text
issue
  -> orchestration skill
  -> fresh coding agent
  -> implementation skill + supporting skills
  -> CI
  -> fresh audit agent
  -> audit skill
  -> remediation agent
  -> CI
  -> more audit/remediation cycles
```

The failure is architectural, not merely prompt quality. Too much control-plane work is delegated to language models: deciding what to run, re-reading state, restating evidence, coordinating other agents, rebuilding handoffs, and deciding when to stop. Fresh contexts improve independence but multiply token cost and latency. A nominal maximum-cycle setting does not create a meaningful budget when each cycle can itself expand arbitrarily.

Delivery V2 therefore adopts one rule above all others:

> **Deterministic software controls AI; AI does not control the delivery system.**

GitHub is the durable control plane. AI is invoked only for work that benefits from reasoning, code generation, or semantic review.

## 2. Outcomes

Delivery V2 must:

- make small, low-risk changes materially faster and cheaper than the V1 full-delivery path;
- keep sensitive changes at least as safe as the old full gate;
- make repository/PR/SHA identity explicit at every transition;
- keep AI calls bounded by provider, model, risk, attempts, turns, credits, and wall-clock policy;
- eliminate silent provider/model fallback;
- avoid mandatory nested ChatGPT Skills in the normal V2 path;
- make CI depth proportional to deterministic risk;
- preserve independent semantic review where risk justifies it;
- prevent material structural regression and prefer evidence-backed reuse over avoidable parallel abstractions;
- fail closed when evidence, identity, classification, AI selection, structural hygiene, or release state is uncertain;
- persist enough state that a new process or chat can resume from the repository/GitHub without reconstructing decisions from conversation history;
- expose measurable cost, latency, retry, and quality signals;
- retire V1 only after V2 is proven in real repositories.

The target architecture is:

```text
GitHub Issue / PR
      |
      v
deterministic identity + risk + policy
      |
      v
bounded Reuse Discovery
      |
      v
bounded AI implementation worker (only when needed)
      |
      v
safe-output PR / exact material SHA
      |
      v
Structural Delta Check + deterministic adaptive CI
      |
      v
Technical Hygiene Gate
      |
      v
risk-based independent semantic review
      |
      v
bounded remediation state machine
      |
      v
exact-head release gate
      |
      v
human/repository-policy merge
```

## 3. Source-of-truth hierarchy

The durable contract is intentionally split by responsibility rather than duplicated:

1. `docs/delivery-v2/MASTER_SPEC.md` — normative architecture and invariants.
2. `config/delivery-v2-requirements.json` — machine-readable requirement IDs, status, evidence pointers, and completion policy.
3. `docs/delivery-v2/ROADMAP.md` — sequencing and exit conditions.
4. GitHub issue #27 — operational umbrella, links, active findings, and cross-repository rollout.
5. Code/tests/workflows — executable implementation.

`docs/delivery-v2.md` is a quick operational summary only. It cannot override this master specification.

A new ChatGPT/Codex/Claude session continuing the project must first read the four items above. Conversation memory is optional context, never a correctness dependency.

## 4. Non-negotiable invariants

### 4.1 Deterministic control plane

The controller, not an LLM, owns:

- repository, issue, PR, base ref, head ref, base SHA, material head SHA, and merge-preview SHA;
- risk classification;
- provider/model selection and worker selection;
- budgets and attempt counters;
- workflow/check state;
- structural baseline identity and technical-hygiene evidence freshness;
- release-state transitions;
- audit applicability;
- evidence freshness and SHA binding;
- terminal reason.

AI may propose code, findings, or semantic judgments, but it cannot silently mutate these control-plane facts.

### 4.2 Fail closed

Uncertainty never grants a cheaper path. Missing changed-file evidence, an unknown path, an unrecognized state, ambiguous target identity, missing required check, stale audit, stale or materially `UNKNOWN` technical-hygiene evidence, invalid AI provider/model selection, missing provider authentication, or missing release evidence must promote/block rather than downgrade.

### 4.3 No silent provider/model fallback

The configured provider and model are part of the delivery contract. Supported providers are `codex`, `claude`, and `copilot`. A failed provider invocation, unavailable/invalid configured model, or missing provider authentication is a hard failure for that attempt. The system must not transparently substitute another provider or model.

### 4.4 Exact-SHA evidence

CI, technical-hygiene and audit evidence applies only to the material SHA it actually examined. Any material commit after validation invalidates downstream approvals that depend on the old SHA. The controller must re-enter the minimum safe stage for the new material SHA.

### 4.5 Bounded loops

There are no open-ended AI-on-AI loops. Every implementation and review cycle consumes explicit attempt budgets. Exhaustion escalates to a human with structured findings/state.

### 4.6 No implicit merge authority

Workers do not receive a generic merge capability. Default policy is `noAutomaticMerge=true`. A repository may later opt into an explicit merge policy only through versioned configuration and only after the exact-head release gate. Absence of that explicit policy means human merge.

### 4.7 Reuse-First and No Structural Regression

Before creating a material helper, hook, service, component, DTO, schema, type, repository, adapter or domain function, the worker must perform bounded Reuse Discovery. Preferred decision order is `REUSE_EXISTING -> EXTEND_EXISTING -> LOCAL_REFACTOR -> CREATE_NEW`; `KEEP_SEPARATE` is valid only with evidence, and insufficient material evidence produces `UNKNOWN`.

A candidate must not materially worsen duplication, avoidable parallel abstractions, new dead code, responsibility concentration, avoidable complexity, or fallback/workaround layering relative to the applicable structural baseline. File size, line count, changed-file count or model confidence alone are signals, never the definition of regression.

Durable hygiene policy exists only in this specification and its requirements projection. Repository-specific policy may tune versioned thresholds/tools or promote severity, but cannot disable No Structural Regression, convert material `UNKNOWN` to approval, authorize known duplication, or reverse deterministic facts.

### 4.8 Facts before judgment

Structural decisions follow this precedence:

```text
deterministic facts -> deterministic policy -> bounded semantic judgment (when necessary) -> gate result
```

A model cannot override an incompatible deterministic fact. Material semantic claims about duplication, ownership, dead code, shared abstraction, refactor necessity or root cause require reproducible evidence. When required evidence is missing, the answer is `UNKNOWN`, not an invented architectural conclusion.

## 5. DV2-001 — Deterministic GitHub-native control plane

GitHub is the durable state authority because it already supplies issue/PR identity, immutable commit SHAs, changed files, checks, workflow runs, reviews, and branch state.

The controller must derive a delivery record containing at least:

```text
repository
work_item_kind / number
pull_request_number (when present)
base_ref
head_ref
base_sha
material_head_sha
merge_preview_sha (when applicable)
risk_profile
implementation_provider + implementation_model
audit_provider + audit_model (when applicable)
implementation_attempt
audit_attempt
required_checks
terminal_state
```

The record may be stored as GitHub state, repository artifacts, workflow outputs, or a controller-owned state document, but the values must be reconstructable without chat history. Historical evidence must retain the provider/model identity actually used even if GitHub Variables change later.

## 6. DV2-002 — Provider and model dispatch

Operator-facing AI selection is configured through **GitHub Actions Variables** in `delivery-orchestrator`; a delivery dispatch does not require the operator to reselect the provider/model each time. The controller determines effective risk first, then resolves implementation/remediation and independent-audit AI policy separately.

The implementation dispatcher maps the resolved provider and risk to exactly one compiled worker:

```text
codex   x fast|standard|critical
claude  x fast|standard|critical
copilot x fast|standard|critical
```

### 6.1 Implementation/remediation variables

General role variables:

```text
DELIVERY_IMPLEMENTER_PROVIDER
DELIVERY_IMPLEMENTER_MODEL
```

Risk-specific overrides:

```text
DELIVERY_FAST_IMPLEMENTER_PROVIDER
DELIVERY_FAST_IMPLEMENTER_MODEL
DELIVERY_STANDARD_IMPLEMENTER_PROVIDER
DELIVERY_STANDARD_IMPLEMENTER_MODEL
DELIVERY_CRITICAL_IMPLEMENTER_PROVIDER
DELIVERY_CRITICAL_IMPLEMENTER_MODEL
```

Resolution order is:

```text
risk-specific implementation variable
  -> general implementation variable
  -> versioned orchestrator default
```

### 6.2 Independent-audit variables

General role variables:

```text
DELIVERY_AUDITOR_PROVIDER
DELIVERY_AUDITOR_MODEL
```

Risk-specific overrides:

```text
DELIVERY_STANDARD_AUDITOR_PROVIDER
DELIVERY_STANDARD_AUDITOR_MODEL
DELIVERY_CRITICAL_AUDITOR_PROVIDER
DELIVERY_CRITICAL_AUDITOR_MODEL
```

FAST has no mandatory LLM audit and therefore no FAST auditor override. Audit resolution order is:

```text
risk-specific audit variable
  -> general audit variable
  -> versioned orchestrator default
```

The audit provider/model is resolved independently from the implementation provider/model. Independence still requires a fresh isolated reviewer context; using a different provider/model strengthens separation but is not a substitute for context isolation.

### 6.3 Versioned defaults and runtime

Defaults must be concrete model identifiers, never mutable aliases such as `auto` or `agent`. Current versioned defaults are documented in `docs/delivery-v2/AI_CONFIGURATION.md` and implemented by `src/v2/provider-policy.mjs`.

`gh-aw` is the current implementation-worker execution runtime. Worker sources are compiled to lock workflows with a pinned compiler. `max-ai-credits` is compile-time, so provider/risk variants remain explicit.

Provider authentication policy:

- Codex: `CODEX_API_KEY` or `OPENAI_API_KEY`, or the explicitly configured isolated ChatGPT/Codex credential mode;
- Claude: `ANTHROPIC_API_KEY` or supported WIF where the active runtime supports it;
- Copilot: supported Copilot request/token configuration, with `COPILOT_GITHUB_TOKEN` used by the independent audit CLI runtime.

Secrets contain credentials only. Provider/model names and policy are GitHub Variables. Authentication failure, unsupported provider, or invalid/unavailable configured model stops that attempt. It never triggers provider/model substitution.

Every AI invocation must expose enough GitHub-native evidence to reconstruct role, risk, provider, model, worker/run identity, and candidate lineage.

## 7. DV2-003 — Safe outputs and credential isolation

Agent code execution must not receive a general-purpose privileged write credential.

The worker may receive a read credential for checkout/GitHub reads. Privileged write capability is delegated only through constrained safe outputs with:

- allowed target repositories;
- allowed base branches;
- integrity minimum;
- maximum number of PRs;
- protected file policy;
- risk-specific path envelope;
- no merge output.

A worker that discovers scope outside its envelope stops and reports escalation. It does not broaden its own permissions.

## 8. DV2-004 — Risk profiles, budgets, and work limits

Risk is deterministic and may be manually promoted but never manually downgraded below observed risk.

### FAST

Intended for truly localized, low-risk changes.

Baseline policy:

- focused/related CI;
- max implementation attempts: 2;
- max AI turns: 20;
- max AI credits: 100;
- no mandatory LLM audit;
- full regression after merge (and/or scheduled full regression);
- strict safe-output file envelope.

### STANDARD

Intended for ordinary business/application/API logic with broader coupling but without critical boundaries.

Baseline policy:

- affected tests plus full affected build/type/lint;
- max implementation attempts: 2;
- max AI turns: 40;
- max AI credits: 250;
- focused independent audit when repository/risk policy requires it;
- no database/browser-critical suite unless promoted.

### CRITICAL

Includes migrations/database, authentication/authorization/security, financial/billing logic, shared contracts, CI/workflows, infrastructure/config/dependencies, privileged integrations, or anything the classifier cannot safely prove lower-risk.

Baseline policy:

- full PR regression;
- independent semantic audit required;
- max implementation attempts: 3;
- max audit-remediation attempts: 2;
- max AI turns: 80;
- max AI credits: 500;
- human escalation when ordinary attempt budgets are exhausted or recovery provenance is insufficient.

Budgets are ceilings, not targets. A pre-material control-plane recovery does not raise these ceilings and cannot authorize a fourth material implementation attempt.

### 8.1 Pre-material control-plane recovery

A bootstrap that exhausted its initial reservation budget before producing a usable material candidate remains fail-closed by default. The deterministic controller may grant exactly one recovery dispatch for a control-plane epoch only when all of the following are proven from trusted GitHub/controller evidence:

- the persisted bootstrap status is `escalated-initial-budget-exhausted`;
- the failure stage is `pre-material`;
- the failure class is `infrastructure` or `unknown`;
- the worker conclusion is `failure`, `timed_out`, `startup_failure`, or `cancelled`;
- the prior controller run is provenance-valid;
- the prior checked-out control-plane SHA is available either from the persisted bootstrap lease or, only for legacy leases created before that field existed, from the validated historical controller job checkout log;
- the currently checked-out control-plane `HEAD` is an exact Git SHA and differs from that persisted checked-out control-plane SHA.

The recovery is deterministic controller authority, never AI self-extension. It is represented within the configured implementation-attempt ceiling and is tagged with recovery provenance: the prior implementation-attempt count, the prior/current controller SHAs, the recovery reason, and `grantedImplementationAttempts=1`. The prior exhausted state therefore remains traceable instead of being silently discarded.

The reservation step independently re-derives recovery eligibility from the trusted persisted bootstrap lease and the actually checked-out control-plane SHA. Workflow-provided recovery fields are compatibility cross-checks, not the sole authority. A run that started from older workflow YAML must not silently discard recovery provenance after checking out newer controller scripts; disagreement between workflow-provided recovery data and trusted persisted provenance fails closed.

For a legacy exhausted bootstrap lease that predates `controllerHeadSha`, the prior control-plane SHA may be reconstructed only from the provenance-valid historical controller run by reading the exact SHA emitted by the deterministic checkout's `git log -1 --format=%H`. The workflow-run `head_sha`, dispatch SHA, or another event SHA is not a substitute for the checked-out control-plane identity. Guard and reservation must independently re-derive this legacy evidence, and missing or ambiguous checkout evidence fails closed.

The same control-plane SHA cannot grant a second recovery. If the recovery dispatch also fails before material output, the bootstrap returns to `escalated-initial-budget-exhausted` for that SHA; another recovery requires a later verified control-plane SHA change. Ambiguous provenance, a non-pre-material failure, a material/functional failure, or an ineligible worker conclusion keeps `human-escalation`. Once a usable material candidate exists, normal CI, audit, remediation, exact-head release, and implementation/audit-remediation limits apply unchanged.

## 9. DV2-005 and DV2-006 — Adaptive CI and safe classification

The classifier is deterministic. It decides **how much validation is required**, while each target repository owns the actual commands for build, test, lint, migrations, browser checks, and domain validation.

### 9.1 Ordering

Classification must apply critical/sensitive rules before low-risk allowlists.

### 9.2 FAST is an allowlist, not a default

A path receives FAST only when all of the following are true:

- it is inside a repository-defined, reviewed FAST-safe root;
- it is not a known sensitive boundary;
- it does not match a core critical invariant;
- required changed-file evidence is complete;
- any deterministic dependency/boundary rule remains safe.

Unknown paths are CRITICAL.

A file extension never grants FAST globally. `infra/diagram.svg` and `apps/api/assets/logo.png` are not FAST merely because they are images. Static/style extensions are low-risk only inside explicitly trusted frontend/documentation roots.

### 9.3 Sensitive boundaries

Authentication, authorization, session, identity, permission, protected-route, credential, secret, billing/financial, database/migration, workflow/CI, infrastructure, shared-contract, and similarly privileged surfaces are CRITICAL.

Path keywords are useful but insufficient. Target repositories must be able to register real sensitive entrypoints whose filenames are not self-describing, such as login pages, route guards, auth stores, permission adapters, and identity/session boundaries.

Core invariant: repository-specific configuration may **promote** risk and may define reviewed safe roots, but it cannot override a core CRITICAL classification.

### 9.4 Requested risk

A requested risk profile computes:

```text
effective_risk = max(observed_risk, requested_risk)
```

No request can lower observed risk.

## 10. DV2-007 — Distribution to public and private repositories

`delivery-orchestrator` remains private. Public repositories cannot depend directly on a private reusable workflow/action, so the official distribution strategy is **generated vendoring**, not ad hoc copying.

The orchestrator must provide an export/sync command that emits a self-contained target-repository policy package containing:

- deterministic classifier runtime;
- policy schema version;
- orchestrator source version/commit;
- canonical policy fingerprint;
- target repository overrides;
- generated policy lock/fingerprint;
- verification command.

The generated files are committed in the target repository. Updates are propagated by an orchestrator-created PR. Target CI can verify that the generated files and lock agree.

Repository overrides may:

- add always-CRITICAL paths/boundaries;
- add repository-specific STANDARD roots;
- add FAST-safe roots only through explicit reviewed configuration;
- never weaken core invariants or change unknown-path fail-closed behavior.

A future public minimal action is allowed only by a deliberate architectural change. It is not required for V2 completion.

## 11. CI execution contract

Target repositories retain concrete commands.

A typical PR route is:

```text
collect exact changed paths
  -> classify
  -> bounded reuse discovery
  -> implement
  -> structural delta check
  -> validate merge-preview compatibility
  -> validate exact material head using exactly one risk path
  -> technical hygiene gate
  -> independent audit when applicable
  -> final stable required status
```

### FAST CI

Typical minimum:

- affected type/lint;
- explicit changed tests;
- `related` tests for changed source;
- affected build;
- applicable architecture/docs checks;
- no PostgreSQL/migrations/browser/full suite.

### STANDARD CI

Typical minimum:

- type/lint;
- affected or non-database tests;
- full affected application build;
- architecture/access/docs as applicable.

### CRITICAL CI

Preserves the repository's complete pre-existing safety gate, including database/migrations/browser/integration regressions where present.

### Merge preview

Merge-preview compatibility and exact-head validation are separate concerns. Expensive suites should not be duplicated in merge-preview unless the repository has a specific reason.

### Post-merge safety net

FAST and STANDARD rely on a full post-merge and/or scheduled regression safety net. This never substitutes for exact-head checks that the risk profile requires.

## 12. DV2-008 — GitHub-native independent audit

The normal V2 audit gate must not depend on a legacy `.audit/entregar-issue/handoff-ready.json`.

The auditor obtains identity/evidence from GitHub and structured V2 outputs:

```text
repository
issue / PR
base_ref + base_sha
head_ref + exact material_head_sha
merge_preview_sha
observed risk + reasons
classifier version/fingerprint
required checks + conclusions
technical hygiene result + exact structural evidence references
workflow run IDs
changed paths
implementation attempt count
implementation provider + model + worker identity
audit provider + model + reviewer identity
prior V2 findings for this same candidate lineage
```

Historical V1 certificates inherited from older Git history are never required by the active V2 audit path.

### Independence

For CRITICAL, the semantic reviewer must be independent of the implementing agent context. Independence means the reviewer receives candidate code/evidence and the contract, but not the implementer's hidden reasoning. It does not require replaying the full V1 Skill ritual. The audit role resolves its own provider/model GitHub Variables and uses an isolated reviewer runtime; it does not inherit implementation provider/model selection implicitly.

### Audit output

Audit findings must be machine-usable and include:

- stable finding ID;
- severity;
- exact candidate SHA;
- violated contract/requisite;
- affected path/surface;
- concrete failure mode;
- reproducible or discriminating evidence;
- remediation mode (`targeted` or `systemic`);
- whether the finding blocks release.

An audit is not allowed to reuse approval from another material SHA. Audit evidence must persist the reviewer provider/model actually invoked for that candidate.

### Audit context budget

The audit bundle is bounded before the model is invoked. The budget includes the sanitized issue/PR projections in addition to bounded diff, manifests, contract, structural-hygiene evidence and material context. Raw GitHub PR/base/head API objects are not model context.

Current hard ceilings are:

- STANDARD: issue body 24 KiB, PR body 16 KiB, total bundle 128 KiB;
- CRITICAL: issue body 48 KiB, PR body 32 KiB, total bundle 256 KiB.

If an issue/PR body would be truncated or the total bundle exceeds its risk budget, the runtime emits a deterministic blocking `audit-context-insufficient` result and performs **zero audit-provider calls**. It never sends known-incomplete contract context to a model just to save bytes. Diff/material sub-budgets remain separately enforced.

### Policy by risk

- FAST: no mandatory LLM audit solely because the hygiene gate exists when no material finding/`UNKNOWN` requires semantic review.
- STANDARD: focused independent audit when configured by policy or promoted by detected risk; material structural findings enter the bounded bundle when applicable.
- CRITICAL: independent audit mandatory.

## 13. DV2-009 — Bounded remediation state machine

The controller maintains explicit states rather than free-form agent conversations:

```text
queued
classified
implementing
ci-pending
ci-failed-remediable
audit-pending
audit-failed-remediable
ready-for-human-merge
escalated
terminal
```

Transitions are deterministic and SHA-bound.

Rules:

1. CI failure with actionable repository cause consumes an implementation/remediation attempt.
2. CI failure from external infrastructure does not trigger unrelated code changes.
3. Audit failure must contain actionable findings. Those findings become the only remediation input unless the new diff opens a new risk surface.
4. A remediation material commit invalidates CI, technical-hygiene and audit evidence from the old material SHA.
5. Attempt ceilings come from the effective risk profile.
6. Exhausted implementation or audit budgets transition to `escalated` with a concise human packet.
7. The controller never recursively asks an AI to orchestrate another AI.
8. Every remediation is compared both with the initial delivery baseline and the immediately previous material SHA so incremental and cumulative structural regressions are visible.

## 14. DV2-010 — Exact-head release gate

A stable final required status must aggregate release readiness.

For a PR to become `ready-for-human-merge`:

- current remote head equals the material SHA being evaluated;
- merge-preview compatibility is acceptable when required;
- the classifier result and fingerprint apply to that head;
- all required CI for the effective risk is terminal green;
- the Technical Hygiene Gate is terminal for the same material SHA with `PASS` or `PASS_WITH_DEBT`;
- no material structural `UNKNOWN` remains pending;
- required independent audit for that risk is approved for the same head;
- no unresolved blocking finding exists;
- no budget/external blocker exists;
- no material commit appeared after the evidence was collected.

If the head changes, readiness returns to an earlier state automatically.

The controller publishes the aggregate exact-head result under the target's configured final status (currently `Delivery V2 release`). Merge enforcement is a separate repository capability and must be represented explicitly in target policy:

- `native-required-status`: branch/ruleset protection demonstrably requires the same final status;
- `controller-status-only`: the controller publishes the exact-head status, but GitHub does not natively enforce it for merge; this mode must carry an explicit limitation and must never claim native protection.

A green release status is evidence, not proof that branch protection exists. Where native enforcement is unavailable, human/manual merge remains an external governance boundary. The release gate stores references to evidence; it does not create an extra result-only commit just to certify what GitHub already attests.

## 15. DV2-011 — Observability and cost accounting

V2 is incomplete without evidence that it is actually cheaper/faster.

Every delivery should emit normalized metrics:

- repository, issue, PR, risk, provider/model identity by AI role;
- classifier version/fingerprint;
- number of provider calls;
- implementation attempts;
- audit attempts;
- Technical Hygiene result and promotion/block/unknown counts;
- semantic-hygiene provider calls when any;
- AI turns/credits/tokens where available;
- provider cost where available;
- CI queue time and execution time;
- audit time;
- end-to-end time;
- terminal reason;
- number of files/lines changed;
- whether escalation occurred.

Metrics must be usable for per-repository and cross-repository comparisons. Provider-sensitive cost values must never expose secrets. Observability state is persisted with the controller and survives deterministic re-entry; a resumed delivery must continue the same counters/usage accumulator rather than restart them. Provider runs are deduplicated by run identity. Missing provider telemetry remains `null`; a deterministic audit rejection that makes no model call records zero provider calls without fabricating token values.

The first measured FAST pilot in `controle_calorias` observed approximately 128 seconds versus an earlier approximately 1,255-second full baseline (~89.8% reduction, ~9.8x faster). This is evidence, not a universal SLA.

## 16. DV2-012 — `controle_calorias` pilot

The first pilot proved the central hypothesis:

- adaptive gate merged;
- push path retained full regression;
- a real low-risk UI/accessibility PR was classified FAST;
- related tests ran;
- full test shards and unrelated gates were skipped;
- build and exact-head gate stayed green;
- measured runtime was dramatically below the old full path.

The pilot is considered rolled out, but future classifier distribution must replace divergent manual copies with the versioned vendoring contract from DV2-007.

## 17. DV2-013 — `training-system` pilot

`training-system` is the second pilot because its historical PR gate is intentionally heavy: PostgreSQL, Prisma migrations, regression scripts, full tests, build, browser validation, architecture, access catalog, and documentation.

The pilot is complete only when:

1. the classifier treats real authentication/access/session entrypoints as CRITICAL;
2. static extensions outside trusted roots do not receive FAST;
3. operational docs match the new artifact/gate behavior;
4. the migration PR receives full CRITICAL CI on its exact head;
5. required independent audit approves that exact head;
6. a real small UI change proves FAST;
7. the benchmark and executed/skipped steps are recorded.

Rollout means that the generated adaptive routing is merged and active on the target branch and the real FAST benchmark is captured as exact-head evidence. The deliberately disposable benchmark PR does **not** have to be merged solely to prove routing rollout; its immutable head/run/artifact remain validation evidence. The `training-system` routing migration is active on `develop`, and the real FAST benchmark is recorded, so DV2-013 is `rolled-out`.

A green CRITICAL self-test does not prove the future FAST/STANDARD routing by itself; adversarial classifier tests are mandatory.

## 18. DV2-014 — V1 and nested-Skill retirement

V1 is retired from the active tree and normal delivery path. Minimal historical provenance may remain only in the dedicated V2 history area and Git history; it is not a runnable fallback.

Retirement includes:

- disabling/removing legacy `delivery-request` orchestration paths from the default route;
- removing normal-path dependence on nested Skills and legacy delivery certificates;
- removing dead `max_cycles`/legacy loop code when no consumer remains;
- closing or migrating active V1 queue items;
- updating README/docs/capabilities so V2 is the default;
- preserving only history needed for traceability.

Any reintroduction of active V1 orchestration or retired snapshot roots is a regression.

## 19. DV2-015 — Executable completeness contract

`config/delivery-v2-requirements.json` contains stable `DV2-*` IDs. Every requirement has:

- status;
- whether it is required for V2 default;
- optional `minimumCompletionStatus` (`validated` by default; `rolled-out` when real rollout is part of completion);
- implementation references;
- validation references;
- rollout references;
- tracking issue.

`scripts/verify-delivery-v2-completeness.mjs` validates that:

- IDs are unique and use the stable format;
- every manifest ID is represented in this specification and the roadmap;
- documentation does not introduce unknown `DV2-*` IDs;
- terminal statuses have validation evidence;
- rolled-out statuses have rollout evidence;
- local `file:` evidence exists;
- every required requirement meets both a globally terminal status and its own minimum completion maturity when `--require-complete` is requested.

A requirement whose minimum is `rolled-out` is incomplete while merely `validated`, even though `validated` is terminal for requirements that do not require rollout. Normal CI runs structural verification; strict `--require-complete` is the release/retirement regression gate.

## 20. DV2-016 — Persistent resumable delivery state

A new process must be able to resume without a long conversational handoff.

At minimum, persistent state must retain:

- target identity;
- material SHA;
- effective risk and classifier fingerprint;
- implementation provider/model and, when applicable, audit provider/model;
- current state;
- implementation/audit attempt counters;
- workflow/check references;
- current structural-hygiene evidence reference/result for the material SHA when produced;
- current blocking findings;
- evidence references;
- last terminal/non-terminal reason.

Controller metadata may additionally persist observability accumulation needed for DV2-011. State updates must be idempotent and tied to observed GitHub identity. A stale state document cannot override fresher remote PR/SHA facts.

### 20.1 Legacy PR adoption before complete operational evidence

A trusted existing PR without canonical V2 state may enter the explicit `legacy-adopted` checkpoint without claiming V2 creation or consuming an initial implementation attempt. The checkpoint is separate from the complete persistent operational-state schema: identity and adoption provenance are mandatory; unknown classifier, risk, audit and historical counters are represented by `null`, never invented defaults. Proven bootstrap counters retain source-comment provenance. Normal managed-PR recovery remains governed by its existing correlated-worker contract.

A trusted exact-identity audit-continuation request may advance this checkpoint through deterministic `post-write-refreeze` after checkout of the exact PR head, canonical classification and observation of authorized terminal-green exact-head CI. The request is not independent audit approval. Refreeze is evidence-only and cannot mutate the material candidate, reset historical budgets, dispatch an initial implementation, or grant release readiness.

When historical audit counters are unknown, they remain `null`. A refrozen adoption may instead allocate a separate, explicit and bounded post-adoption audit budget that is valid only for the current exact material head. Its nonce, workflow run identity and result evidence must be durable and re-entry-safe. The first audit may represent the material producer explicitly as `legacy-unknown`; it must never synthesize an implementation provider, worker run or attempt count. Auditor provider/model selection, isolated context, workflow provenance, exact-head result validation and release requirements remain identical to the normal GitHub-native audit contract.

After the refreeze, a new operational epoch may be created for the adopted candidate with zero **new V2 implementation attempts** and imported exact-head green CI evidence. These counters describe only work performed after adoption and are not historical reconstruction. Audit rejection follows the normal bounded same-PR audit-remediation state machine. Audit approval still requires same-head Technical Hygiene and the standard exact-head release gate. Evidence-only hygiene collection must not mutate the PR head or become the claimed material producer. Head/base drift invalidates candidate-bound refreeze/audit/hygiene evidence; stale evidence cannot authorize release. The legacy adoption checkpoint remains separate provenance throughout.

## 21. Security model

The controller follows least privilege:

- read credentials for agent checkout/inspection;
- write capability through constrained safe outputs;
- protected governance paths blocked from low-risk workers;
- repository allowlists;
- fail-closed integrity level;
- no secret echoing;
- no automatic broadening of network/tool access;
- no provider/model fallback;
- no automatic merge by default.

Risk classification, structural-hygiene policy and AI provider/model dispatch are security boundaries and must be tested adversarially.

## 22. Repository policy contract

Each target repository owns a small versioned policy describing:

```text
base branches
required final status name
FAST-safe roots
STANDARD roots
always-CRITICAL paths/boundaries
repository-specific critical integrations
structural-analysis tools/thresholds (optional, promotion-only)
post-merge full-regression workflow
merge policy + enforcement mode/limitation
```

The policy cannot weaken orchestrator core invariants. It cannot convert material hygiene `UNKNOWN` into warning/PASS, disable No Structural Regression, authorize known duplication, or represent `native-required-status` unless native enforcement is actually present. Its generated fingerprint is included in classification evidence.

## 23. Completion criteria

Delivery V2 may be declared the default and V1 retirement may complete only when all `requiredForV2Default=true` requirements satisfy their configured minimum completion maturity. The default minimum is `validated`; requirements whose contract includes real rollout use `minimumCompletionStatus: rolled-out`.

In practical terms that includes:

- foundation/provider execution validated;
- hardened fail-closed classifier;
- deterministic versioned distribution to public/private repositories;
- GitHub-native independent audit;
- bounded remediation;
- exact-head release gate;
- persistent resumable state;
- observability/cost accounting;
- Reuse-First and Technical Hygiene structural protection;
- `controle_calorias` pilot rolled out;
- `training-system` adaptive routing rolled out with real FAST benchmark evidence;
- completeness gate itself validated;
- V1 retirement performed and verified.

A partially implemented roadmap is never described as "Delivery V2 complete."

## 24. Continuation protocol for a new chat or agent

To continue this program safely in a new context:

1. Read `docs/delivery-v2/MASTER_SPEC.md`.
2. Read `config/delivery-v2-requirements.json`.
3. Read `docs/delivery-v2/ROADMAP.md`.
4. Read GitHub issue #27 and its latest comments.
5. Run `npm run verify:v2`.
6. Select the earliest/highest-priority non-terminal requirement whose dependencies are terminal.
7. Implement against its stable `DV2-*` ID.
8. Update the manifest status/evidence in the same PR only when justified by executable evidence.
9. Never infer missing architectural decisions from old chats when the repository contract already answers them.

A sufficient continuation prompt is:

```text
Continue Delivery V2 in crgasparoto-br/delivery-orchestrator.
Treat docs/delivery-v2/MASTER_SPEC.md and config/delivery-v2-requirements.json as canonical.
Use docs/delivery-v2/ROADMAP.md and issue #27 for sequencing/tracking.
Implement the next non-terminal requirements without weakening the documented invariants.
Run npm run verify:v2 and the applicable V2 CI.
```

This protocol is the guarantee that the project does not depend on preserving one conversation.

## 25. DV2-017 — Technical Hygiene Gate, Reuse-First and structural regression protection

DV2-017 makes structural quality a first-class, exact-SHA release invariant without turning the orchestrator into a repository-wide AI reviewer.

### 25.1 Reuse Discovery

Before creating a relevant abstraction, search bounded context in this priority order:

1. files touched by the issue;
2. direct local imports/dependencies;
3. the related domain/directory;
4. bounded symbolic/semantic search.

The machine decision vocabulary is `REUSE_EXISTING`, `EXTEND_EXISTING`, `LOCAL_REFACTOR`, `CREATE_NEW`, `KEEP_SEPARATE`, and `UNKNOWN`. A material decision requires reproducible evidence. When bounded discovery cannot prove owner/equivalence and the distinction matters, the result is `UNKNOWN`, not assumed permission for `CREATE_NEW`.

### 25.2 Structural baseline and delta

The initial structural baseline is the deterministic `base_sha`. For remediation, the controller preserves both the initial baseline and the immediately previous material SHA. Structural evidence is bound to the current `material_sha`; a new material commit invalidates the previous approval while immutable baseline facts may be reused if the base identity is unchanged.

The delta may use deterministic signals such as file growth, function/class/component additions, supported complexity/nesting measurements, duplication candidates, dead-code evidence, fallback/workaround additions and parallel-owner candidates. A metric is a signal, not a universal quality rule. Missing stack-specific tooling does not itself cause `BLOCK`; it produces `UNKNOWN` only when the missing evidence is material to an observed decision.

### 25.3 Structural budget

The budget evaluates growth + responsibility + complexity + duplication rather than a blind maximum line/file count. Preexisting debt outside scope is not mandatory refactor. If the candidate does not materially worsen it, `PASS_WITH_DEBT` is valid. A cohesive split of a monolith may increase file count and still improve structure.

A second fallback/workaround for the same behavior requires reproducible root-cause evidence. Stacking defensive behavior without that evidence is `BLOCK`.

### 25.4 Technical Hygiene Gate

The gate has exactly four principal results:

- `PASS` — no material structural regression and sufficient evidence;
- `PASS_WITH_DEBT` — preexisting debt exists but the candidate does not materially aggravate it;
- `BLOCK` — a material regression or mandatory invariant violation is proven;
- `UNKNOWN` — a material decision required for release lacks sufficient evidence.

`UNKNOWN` never equals approval. FAST with material `UNKNOWN` promotes to at least STANDARD for reevaluation; persistent material uncertainty then blocks/escalates. STANDARD/CRITICAL material `UNKNOWN` blocks release until evidence/remediation or human escalation according to budget. Non-material uncertainty may be telemetry only when deterministic evidence proves it cannot affect these invariants.

A compact machine result is bound to the candidate and contains at least:

```json
{
  "schemaVersion": 1,
  "materialSha": "...",
  "baselineSha": "...",
  "previousMaterialSha": null,
  "reusedSymbols": [],
  "extendedSymbols": [],
  "createdSymbols": [],
  "createdFiles": [],
  "structuralFindings": [],
  "missingEvidence": [],
  "result": "PASS",
  "evidenceRef": "..."
}
```

### 25.5 Semantic ambiguity and anti-hallucination rules

Deterministic analysis runs first. Textual similarity is not semantic equivalence, and different names do not prove separation. Only relevant ambiguity may be sent to AI, with bounded code pairs, issue contract and minimum surrounding context. Material semantic decisions must reference reproducible evidence. `confidence` is telemetry only.

The implementer is not the sole authority for a material semantic hygiene judgment. When a profile lacks independent audit but a material semantic decision is necessary, the hygiene stage obtains isolated bounded review or promotes/escalates instead of self-approving.

### 25.6 Audit and release integration

FAST does not gain mandatory LLM audit solely from this requirement when deterministic hygiene is terminal and there is no material ambiguity. STANDARD follows the existing audit policy. CRITICAL remains independently audited. Reviewers receive only the bounded structural evidence needed to validate material findings and do not recompute deterministic metrics unnecessarily.

The release gate accepts hygiene only when its `materialSha` equals the exact release candidate and the principal result is `PASS` or `PASS_WITH_DEBT`. `BLOCK`, stale evidence and material `UNKNOWN` cannot be reinterpreted as warnings. Repository-specific configuration cannot weaken this rule.

### 25.7 Efficiency and telemetry

The default is deterministic delta analysis, reused baseline evidence and bounded neighborhood search. AI is called only for real semantic ambiguity. Telemetry must make hygiene `BLOCK`, `PASS_WITH_DEBT`, `UNKNOWN`, FAST promotion and semantic-hygiene calls observable without forcing token-heavy repository inventories.
