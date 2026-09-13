# Delivery Orchestrator

Delivery V2 is the default and only active delivery architecture in this repository. GitHub is the deterministic control plane for candidate identity, risk, CI, bounded remediation, independent audit, persistent state and release evidence. AI providers are bounded implementation/review workers; they do not orchestrate the delivery system.

## Start a delivery

Use **Delivery V2 - Dispatch** (`.github/workflows/delivery-v2-dispatch.yml`). Provide target repository, issue, provider, requested risk and base branch. Optional `changed_paths` can narrow the initial deterministic classification.

The dispatch workflow now owns the normal path end to end:

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

Risk remains fail-closed. Unknown or missing changed-file evidence is a **CRITICAL security classification**, but V2 no longer interprets missing initial paths as permission to spend the CRITICAL 80-turn / 500-credit implementation budget. In `auto` mode, unresolved scope stops before a provider call and asks for concrete paths; once material scope exists, normal FAST/STANDARD/CRITICAL budgets apply.

- FAST: 20 turns / 100 credits, focused validation, no mandatory LLM audit.
- STANDARD: 40 turns / 250 credits, affected validation/build and focused independent audit by policy.
- CRITICAL: 80 turns / 500 credits, full PR regression and independent audit.

Requested risk can promote but never downgrade observed risk. Provider selection is explicit; provider failure never silently substitutes another provider.

## Bounded remediation

All provider/risk workers support two controller-selected modes:

- initial mode: create one managed PR with a `[delivery-v2] ` title and issue-closing body;
- remediation mode: work on the exact existing PR head and use constrained `push-to-pull-request-branch` safe output. A remediation worker cannot create a replacement PR.

FAST keeps the same file envelope on both initial PR creation and follow-up remediation. Protected files, repository allowlists and write-token isolation remain enforced for every risk profile.

## Independent audit

`.github/workflows/delivery-v2-audit.yml` is the generic normal-path audit. It is no longer tied to issue #27 or a pilot marker. The deterministic controller supplies target repository/PR, exact material SHA through the trusted source CI run, effective risk and target CI workflow identity.

The reviewer receives a sanitized bundle containing only exact audit identity/evidence, issue/PR contract, a bounded candidate diff, integrity manifest, bounded material context and the relevant Delivery V2 audit contract. Product-repository audits use `docs/delivery-v2/AUDIT_CONTRACT.md`; control-plane changes in this repository use the full `MASTER_SPEC.md`. Hidden implementer reasoning, generated artifacts and unrelated repository inventory are excluded.

Audit context is risk-adaptive without changing release semantics: STANDARD is capped at 80 KiB aggregate model material (32 KiB diff + 48 KiB exact-SHA material context), while CRITICAL retains the 160 KiB ceiling (64 KiB + 96 KiB). If a bounded omission is material to a blocking conclusion, the auditor must fail closed with `audit-context-insufficient` instead of guessing.

## Observability and cost accounting

Compiled `gh-aw` workers retain native `usage` artifacts. The normal controller ingests those artifacts and preserves turns/credits/input/output/total tokens when the provider reports them. Missing usage remains `null`/unknown — never fabricated as zero. Audit model usage is included in the same delivery record.

The final controller artifact records provider calls, implementation/audit attempts, AI usage, CI/audit/end-to-end duration, change size, exact material SHA, evidence references and terminal state. This is the feedback surface for future budget/model/provider tuning.

## V1 retirement

**V1 is retired.** The former `delivery-loop.yml`, `delivery-request:` queue, `max_cycles` controller, recursive implement/audit loop, nested-Skill normal path and mandatory `.audit/entregar-issue` handoff/certificate path are not active entrypoints.

The former `.audit/entregar-issue/**` and `skills/catalog/**` snapshot roots are now physically removed from the active tree and ignored so local/generated tooling cannot reintroduce them accidentally. Minimal V1 provenance remains only under `docs/delivery-v2/history/v1/**` and in Git history; active V2 workflows and scripts have no dependency on the retired roots.

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

`verify:v2` runs the regular completeness and target-policy checks. `verify:v2:complete` adds the strict terminal-completeness assertion without repeating the target-policy scan. `Delivery V2 CI` remains the trusted automatic exact-head gate and performs the single automatic `gh-aw` compile only when worker/compiler identity changed; otherwise it reuses the trusted-base attestation. The CI trigger covers repository scripts by surface rather than a manually maintained filename list. `Delivery V2 - Compile gh-aw` is retained only as a manual preflight.
