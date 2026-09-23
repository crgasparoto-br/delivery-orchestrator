# Delivery Orchestrator

Delivery V2 is the default and only active delivery architecture in this repository. GitHub is the deterministic control plane for candidate identity, risk, CI, bounded remediation, independent audit, persistent state and release evidence. AI providers are bounded implementation/review workers; they do not orchestrate the delivery system.

## Start a delivery

Use **Delivery V2 - Dispatch** (`.github/workflows/delivery-v2-dispatch.yml`). Provide target repository, issue, provider, requested risk and base branch. Optional `changed_paths` can narrow the initial deterministic classification.

The dispatch workflow owns the normal path end to end:

```text
issue + deterministic scope evidence
      |
      +--> unresolved auto scope: fail closed, 0 provider calls, request concrete paths
      |
      v
bounded provider/risk worker
      |
      v
managed PR + exact material SHA
      |
      v
target repository adaptive CI
      |
      +--> actionable failure -> same-PR bounded remediation worker
      |
      v
risk-required GitHub-native independent audit
      |
      +--> blocking findings -> same-PR bounded remediation worker
      |
      v
exact-head release gate -> ready-for-human-merge / escalated
```

State is persisted back to the managed PR. Each material commit invalidates older CI/audit evidence and the controller resumes from the minimum safe stage. The controller never asks one AI worker to coordinate another.

The local deterministic planner remains available:

```bash
npm run plan:v2 -- --repo crgasparoto-br/example --issue 123 --provider codex --risk auto --path apps/web/src/App.tsx
npm run dispatch:v2 -- --repo crgasparoto-br/example --issue 123 --provider codex --risk auto --path apps/web/src/App.tsx
```

`dispatch:v2` is a local planning/dispatch-decision command only; the GitHub workflow is the durable operational entrypoint.

Other V2 control-plane commands:

```bash
npm run resume:v2 -- --state-file /path/state.json --repo owner/repo --pr 123 --head-ref branch --remote-head <sha>
npm run metrics:v2 -- --metrics-file /path/metrics.json
npm run normalize-usage:v2 -- --json /path/agent_usage.json
npm run verify:v2
npm run verify:v2:complete
```

## Risk and AI budgets

Risk remains fail-closed. Unknown or missing changed-file evidence is a **CRITICAL security classification**, but V2 does not interpret missing initial paths as permission to spend the CRITICAL 80-turn / 500-credit implementation budget. In `auto` mode, unresolved scope stops before a provider call and asks for concrete paths; once material scope exists, normal FAST/STANDARD/CRITICAL budgets apply.

- FAST: 20 turns / 100 credits, focused validation, no mandatory LLM audit.
- STANDARD: 40 turns / 250 credits, affected validation/build and focused independent audit by policy.
- CRITICAL: 80 turns / 500 credits, full PR regression and independent audit.

Runtime limits for FAST, STANDARD and CRITICAL may be overridden through repository variables using `DELIVERY_<PROFILE>_MAX_AI_CREDITS`, `DELIVERY_<PROFILE>_MAX_AI_TURNS` and `DELIVERY_<PROFILE>_MAX_IMPLEMENTATION_ATTEMPTS`. When an override is absent, the versioned baseline remains in effect.

Pre-material bootstrap recovery is narrow and owned by the deterministic controller, not by an AI worker. For eligible `pre-material` infrastructure/unknown failures, exactly one recovery dispatch may be granted after a verified change of the control-plane SHA. Separately, a `reserved-initial-attempt` whose correlated worker completed successfully but produced no managed PR may be re-armed after a verified control-plane SHA change; reservation restores the same implementation-attempt number instead of consuming another slot. Same-SHA re-entry remains fail-closed, recovery provenance is persisted, and the configured implementation ceiling is not increased.

Requested risk can promote but never downgrade observed risk. Provider selection is explicit; provider failure never silently substitutes another provider.

## Bounded remediation

All provider/risk workers support two controller-selected modes:

- initial mode: create one managed PR with a `[delivery-v2] ` title and issue-closing body;
- remediation mode: work on the exact existing PR head and use constrained `push-to-pull-request-branch` safe output. A remediation worker cannot create a replacement PR.

FAST keeps the same file envelope on both initial PR creation and follow-up remediation. Protected files, repository allowlists and write-token isolation remain enforced for every risk profile.

## Worker sandbox toolchain

The `codex` FAST/STANDARD/CRITICAL workers execute inside an isolated `gh-aw` agent sandbox (`awf`) with its own constructed `PATH`, separate from the GitHub Actions runner host. Installing a tool on the host (for example `apt-get install git`) does not by itself make it resolvable inside that sandbox. Each `delivery-v2-worker-codex-*.md` workflow:

- declares `runtimes.node` so `node`/`npm` are provisioned through `gh-aw`'s own compiler-managed mechanism instead of an ambient host assumption;
- registers the host `git` executable into the `RUNNER_TOOL_CACHE` toolcache bin-directory convention (`.github/scripts/ensure-delivery-v2-worker-sandbox-toolchain.mjs`), the same discovery mechanism the sandbox uses to build its `PATH`;
- installs `pnpm 9` before the sandbox preflight and requires it alongside `git`, `node`, `npm` and `safeoutputs` in the effective toolchain;
- preserves the curated sandbox `PATH` through the trusted bootstrap and starts Codex with `allow_login_shell=false`, preventing login profiles from replacing that `PATH` in commands executed by the agent;
- validates the required `safeoutputs` operations, including the non-material `noop` used by evidence-only technical hygiene;
- keeps a `bash -lc` compatibility probe in the preflight, while regression coverage explicitly proves that a destructive login profile loses the toolchain and the corresponding non-login shell preserves it.

This closes the sandbox-toolchain regressions tracked by issues #151 and #166 against the original fix in #108/#112. The earlier protection proved tools at the outer sandbox boundary; #166 additionally requires proving that the Codex child command shells preserve the same effective toolchain.

## Independent audit

`.github/workflows/delivery-v2-audit.yml` is the generic normal-path audit. It is not tied to issue #27 or a pilot marker. The deterministic controller supplies target repository/PR, exact material SHA through the trusted source CI run, effective risk and target CI workflow identity.

The reviewer receives a sanitized bundle containing only exact audit identity/evidence, bounded issue/PR projections, a bounded candidate diff, integrity manifest, bounded material context and the relevant Delivery V2 audit contract. Product-repository audits use `docs/delivery-v2/AUDIT_CONTRACT.md`; control-plane changes in this repository use the full `MASTER_SPEC.md`. Hidden implementer reasoning, generated artifacts and unrelated repository inventory are excluded.

Audit context is risk-adaptive at two levels. Diff/material sub-budgets remain STANDARD 32 KiB + 48 KiB and CRITICAL 64 KiB + 96 KiB. A total pre-model budget also includes issue/PR projections and all bundle files: STANDARD caps issue body at 24 KiB, PR body at 16 KiB and total bundle at 128 KiB; CRITICAL uses 48 KiB, 32 KiB and 256 KiB. If issue/PR truncation or the total ceiling would omit material contract context, the runtime emits blocking `audit-context-insufficient` evidence with **zero audit-provider calls** rather than asking a model to guess.

## Observability and cost accounting

Compiled `gh-aw` workers retain native `usage` artifacts. The controller ingests those artifacts and preserves turns/credits/input/output/total tokens when the provider reports them. Missing usage remains `null`/unknown — never fabricated as zero. Audit model usage is included in the same delivery record.

Once operational controller state exists, the observability accumulator is persisted with that state. Re-entry continues the same provider-call/usage record and deduplicates provider runs by run ID; it does not restart operational counters. The final controller artifact records provider calls, implementation/audit attempts, AI usage, CI/audit/end-to-end duration, change size, exact material SHA, evidence references and terminal state. Pre-material bootstrap exhaustion/recovery keeps its provenance on the trusted bootstrap lease instead of fabricating a counter above the configured implementation ceiling. Legacy state that predates persistent observability is labeled rather than reconstructed from guesses.

### AI Usage & Cost Reporting

**Operational source.** There is exactly one cross-delivery source of AI usage/cost history:
`docs/delivery-v2/evidence/delivery-v2-metrics.json` (override with `DELIVERY_V2_METRICS_FILE`),
resolved by `src/v2/metrics-store.mjs`. Both the initial and the resume controller persist each
completed delivery into it through the canonical `upsertDeliveryMetrics` contract in
`src/v2/metrics.mjs`, keyed by `deliveryId`, so resume/re-entry replaces rather than duplicates a
delivery. The dispatch workflow publishes the updated store back to the orchestrator's default
branch and uploads it as run evidence. `npm run metrics:v2`, `npm run ai:usage` and the AI Usage
Report workflow all read this same file — there is no second store. Reporting against a store
that does not exist fails loudly rather than quietly producing an empty report; pass
`--allow-missing-store` to opt into the empty-window case explicitly.

**Per-provider-run ledger.** `createControllerDeliveryMetrics` produces `providerRunLedger`
operationally, from the provider observations the controller recorded — callers never supply it.
Entries are keyed by `runId`, the same provider-run identity the controller already deduplicates
on, which is what makes re-entry, resume and recovery non-duplicating. Where evidence exists an
entry preserves `workflowRunId`, `materialHeadSha`, `phase`, `provider`, `model`, `worker`,
`role`, `implementationAttempt`, `remediationAttempt`, token `usage` and `usageAccounting`,
`cache` counters, `reportedCost`, `estimatedCost`, `effectiveCost`, `costProvenance`,
`pricingSnapshot`, `startedAtIso`, `endedAtIso`, `observedAtIso`, `terminalState` and
`evidenceRef`. Fields without evidence stay `null`. The entry schema is a fail-closed allowlist,
so API keys, provider credentials and Actions secrets cannot reach the ledger, the store, the
JSON, the CSV, the HTML or the Job Summary.

**Cost precedence and pricing.** Effective cost follows strict
reported-over-estimated-over-unknown precedence, and reported/estimated are never summed for the
same run — when a cost is reported, no estimate is computed at all. Estimates come from the
versioned in-repository catalog `config/delivery-v2-ai-pricing.json` (`src/v2/ai-pricing.mjs`),
keyed by `provider/model` with an explicit currency; there is never an external pricing lookup
during a delivery. Each estimate persists a `pricingSnapshot` (catalog version plus the exact
rates applied), so revising the catalog only prices runs observed after the change — historical
runs keep their recorded snapshot and cost. An unknown provider/model, or unknown token usage,
stays unknown instead of becoming a fabricated zero. Totals are grouped by currency; different
currencies are never added together and never converted.

**Zero calls vs unknown vs legacy.** These three are kept strictly apart. A delivery *proven* to
have made no provider call has `providerCalls: 0`, an empty ledger and
`providerRunAccounting: 'complete'`; it contributes `zeroProviderCallEntries`, never
`unknownCostEntries`, and never gets fabricated tokens or cost. A real provider run whose cost
could not be determined contributes `unknownCostEntries`. A pre-ledger historical record
contributes `legacyEntries` and keeps working without inventing run-level attribution that was
never captured.

**Timestamps.** A provider run's terminal instant is its own `endedAtIso`, never back-filled from
the delivery-level timestamp or from "now". A run with an unknown terminal instant is excluded
from any bounded window and reported in `unknownTerminalTimestampEntries`. Period filtering
compares real instants, so `Z` and `+00:00` are equivalent, and boundaries are inclusive.

**CLI.** `npm run ai:usage` (`scripts/ai-usage-report.mjs`) supports
`--period all|today|7d|month|custom` (plus the `--today`/`--7d`/`--month[=YYYY-MM]` shorthands),
`--from`/`--to`, `--timezone` (UTC by default, or a fixed `±HH:MM` offset; named timezones are
rejected), `--repo`, `--issue`, `--pr`, `--phase`, `--provider`, `--model`, `--group-by`
(default `repository,phase`; supports `repository`, `issue`, `pr`, `phase`, `provider`, `model`,
`worker`, `role`, `risk`, `delivery`, `day`, `kind`), `--metrics-file`, `--budget-file`,
`--allow-missing-store`, `--json` and `--out`. The human output reports period, timezone,
provider runs/calls, input/output/total tokens, credits, known effective cost per currency,
unknown-cost count, unknown/partial usage counts, the requested breakdown and budget warnings.

**Workflow and exports.** The manual **Delivery V2 - AI Usage Report** workflow
(`workflow_dispatch`, inputs `period`/`from`/`to`/`timezone`/`repository`/`group_by`) runs the
identical CLI to produce one JSON payload, then `scripts/ai-usage-export.mjs` derives the Job
Summary plus `ai-usage-report.json`/`.csv`/`.html` from that single payload, so every surface
agrees on totals by construction. The HTML adds cost per day, per repository, per phase and per
provider/model, the highest-consumption issues and pull requests, and audit/remediation counts.
CSV and JSON preserve `unknown` literally and carry usage/calls/attempts, not only cost.

**Delivery closing summary.** When telemetry exists, the controller result carries an
`## AI usage` block (`src/v2/ai-usage-summary.mjs`) with per-phase calls/tokens, known cost per
currency, unknown-cost run count, tokens and AI calls. It reports `complete` only when every
provider run of that delivery has known usage and known cost and the controller enumerated every
run; otherwise it says `partial`.

**Budget.** `config/delivery-v2-ai-budget.json` (`src/v2/ai-budget.mjs`) declares an optional
`monthly.amount`/`monthly.currency` and `warnings.issueCost`/`warnings.remediationCount`.
`warnings.remediationCount` is evaluated against the remediation provider runs in the window,
overall and per grouping. Budget evaluation only ever adds non-blocking, informative warnings; it
never gates, blocks or delays a delivery. Billing, automatic payment, API key rotation, mandatory
public publication, automatic currency conversion and hard limits are explicitly out of scope.

## Release and merge enforcement

Missing or materially `UNKNOWN` exact-head technical hygiene is persisted as `technical-hygiene-pending`, even when CI and audit are green. A verified control-plane SHA change can rearm full evidence-only collection when at least one material infrastructure item is recoverable, including mixed infrastructure/semantic `UNKNOWN`. Recovery retains the prior complete result and existing CI/audit evidence and attempt counters. Same-SHA re-entry cannot automatically retry collection. If material uncertainty persists after any required FAST promotion, the controller escalates for human intervention without authorizing candidate changes or spending implementation/audit-remediation attempts. A proven Technical Hygiene `BLOCK` is different: it remains actionable and follows the existing bounded `ci-failed-remediable` implementation-remediation path with the hygiene evidence attached.

The exact-head aggregate result is published as `Delivery V2 release`. `config/delivery-v2-controller-targets.json` distinguishes two facts that must not be conflated:

- `native-required-status`: GitHub branch/ruleset protection demonstrably requires the same final status;
- `controller-status-only`: the controller publishes the final status, but native merge enforcement is not configured; an explicit limitation is mandatory and manual merge remains an external governance boundary.

The current private targets are declared truthfully as `controller-status-only`; the repository does not pretend branch protection exists when it cannot verify/enforce it.

## Completeness

The executable completeness gate supports requirement-specific maturity through `minimumCompletionStatus`. The default minimum is `validated`; requirements that include real rollout use `rolled-out`. DV2-012 and DV2-013 therefore cannot regress to “complete” while merely validated. `training-system` DV2-013 is rolled out because the generated adaptive routing is merged and active on `develop` and the real FAST benchmark is preserved as exact-head evidence; the disposable benchmark PR itself does not need to merge solely to prove routing rollout.

## Controller continuation

V2.2 keeps bounded polling within a controller invocation and persistent re-entry across interruptions. Polling performs no model calls. Moving every CI/audit transition to event-driven continuation changes workflow ownership/concurrency/failure semantics and is deferred as a separately governed architecture change; see `docs/delivery-v2/adr/0006-bounded-polling-before-event-driven.md`.

## V1 retirement

**V1 is retired.** The former `delivery-loop.yml`, `delivery-request:` queue, `max_cycles` controller, recursive implement/audit loop, nested-Skill normal path and mandatory V1 handoff/certificate path are not active entrypoints.

Former V1 snapshot roots are physically removed from the active tree and ignored so local/generated tooling cannot reintroduce them accidentally. Active worker prompts now use generic retired/generated-snapshot hygiene instead of carrying obsolete V1 path names. Minimal V1 provenance for **historical traceability** remains only under `docs/delivery-v2/history/v1/**` and in Git history.

## Canonical contract

Architecture and requirement state are versioned in:

- `docs/delivery-v2/MASTER_SPEC.md` — normative architecture and invariants;
- `config/delivery-v2-requirements.json` — machine-readable requirement status/evidence;
- `docs/delivery-v2/ROADMAP.md` — rollout order and exit criteria;
- `docs/delivery-v2/adr/` — accepted architectural decisions;
- issue #27 — completed V2 umbrella history;
- current post-completion issues/PRs — active hardening work.

Conversation history is optional context, never a correctness dependency.

## Validation

For control-plane changes run:

```bash
npm test
npm run validate
npm run verify:v2
npm run verify:v2:complete
```

`verify:v2` runs the strict completeness and target-policy checks. `verify:v2:complete` runs focused strict completeness in isolation. `Delivery V2 CI` remains the trusted automatic exact-head gate and performs the single automatic `gh-aw` compile only when worker/compiler identity changed; otherwise it reuses the trusted-base attestation. The CI trigger covers repository scripts by surface rather than a manually maintained filename list. `Delivery V2 - Compile gh-aw` is retained only as a manual preflight.
