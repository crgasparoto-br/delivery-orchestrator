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

Runtime limits for FAST, STANDARD and CRITICAL may be overridden through repository variables using `DELIVERY_<PROFILE>_MAX_AI_CREDITS`, `DELIVERY_<PROFILE>_MAX_AI_TURNS` and `DELIVERY_<PROFILE>_MAX_IMPLEMENTATION_ATTEMPTS`. When an override is absent, the versioned baseline remains in effect.
- CRITICAL: 80 turns / 500 credits, full PR regression and independent audit.

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
- runs a preflight step, after runtime setup and before "Execute Codex CLI", that fails the workflow immediately if `git`, `node` or `npm` would not resolve inside the sandbox — catching the regression before any AI budget is spent instead of after the worker reports a missing tool.

This closes the regression tracked by issue #151 against the original fix in #108/#112, which only ensured `git` was present on the runner host, not inside the worker's effective execution environment.

## Independent audit

`.github/workflows/delivery-v2-audit.yml` is the generic normal-path audit. It is not tied to issue #27 or a pilot marker. The deterministic controller supplies target repository/PR, exact material SHA through the trusted source CI run, effective risk and target CI workflow identity.

The reviewer receives a sanitized bundle containing only exact audit identity/evidence, bounded issue/PR projections, a bounded candidate diff, integrity manifest, bounded material context and the relevant Delivery V2 audit contract. Product-repository audits use `docs/delivery-v2/AUDIT_CONTRACT.md`; control-plane changes in this repository use the full `MASTER_SPEC.md`. Hidden implementer reasoning, generated artifacts and unrelated repository inventory are excluded.

Audit context is risk-adaptive at two levels. Diff/material sub-budgets remain STANDARD 32 KiB + 48 KiB and CRITICAL 64 KiB + 96 KiB. A total pre-model budget also includes issue/PR projections and all bundle files: STANDARD caps issue body at 24 KiB, PR body at 16 KiB and total bundle at 128 KiB; CRITICAL uses 48 KiB, 32 KiB and 256 KiB. If issue/PR truncation or the total ceiling would omit material contract context, the runtime emits blocking `audit-context-insufficient` evidence with **zero audit-provider calls** rather than asking a model to guess.

## Observability and cost accounting

Compiled `gh-aw` workers retain native `usage` artifacts. The controller ingests those artifacts and preserves turns/credits/input/output/total tokens when the provider reports them. Missing usage remains `null`/unknown — never fabricated as zero. Audit model usage is included in the same delivery record.

The observability accumulator is persisted with controller state. Re-entry continues the same provider-call/usage record and deduplicates provider runs by run ID; it does not restart counters. The final controller artifact records provider calls, implementation/audit attempts, AI usage, CI/audit/end-to-end duration, change size, exact material SHA, evidence references and terminal state. Legacy state that predates persistent observability is labeled rather than reconstructed from guesses.

## Release and merge enforcement

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
