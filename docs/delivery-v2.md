# Delivery V2: GitHub-native, risk-adaptive delivery

## Goal

Move orchestration decisions out of the coding model. GitHub Actions owns deterministic state, CI, budgets, SHA identity and release gates. An AI engine is invoked only for work that needs reasoning or code generation.

V1 remains available during migration. V2 does not silently fall back to V1 or to a different AI provider.

## Provider selection

V2 accepts these providers:

- `copilot` — GitHub Copilot CLI engine;
- `codex` — OpenAI Codex engine;
- `claude` — Anthropic Claude Code engine.

Configuration:

- `DELIVERY_AI_PROVIDER` sets the default provider;
- `DELIVERY_IMPLEMENTER_PROVIDER` optionally overrides the implementation provider;
- `DELIVERY_AUDITOR_PROVIDER` optionally selects a different audit provider;
- `DELIVERY_AI_MODEL`, `DELIVERY_IMPLEMENTER_MODEL`, and `DELIVERY_AUDITOR_MODEL` remain plan metadata until model-specific execution routing is enabled.

Invalid providers fail closed. There is no automatic provider fallback.

GitHub Agentic Workflows (`gh-aw`) is the execution runtime. Conventional GitHub Actions remain responsible for builds, tests, linting and other deterministic checks.

## Risk profiles

`DELIVERY_RISK_PROFILE` accepts `auto`, `fast`, `standard`, or `critical`.

### FAST

Use for bounded presentation/UI fixes and documentation/styles when no sensitive path is touched.

- focused CI;
- maximum 2 implementation attempts;
- 20 AI turns / 100 AI Credits per worker run;
- no mandatory LLM audit by default;
- full regression after merge;
- escalation to `standard` after the retry budget is exhausted.

FAST workers also use a safe-output file allowlist. If the agent needs to touch a path outside the low-risk envelope, PR publication fails closed rather than silently broadening scope.

### STANDARD

Use for ordinary application/API changes.

- affected tests plus build;
- maximum 2 implementation attempts;
- 40 AI turns / 250 AI Credits per worker run;
- one focused independent audit;
- full regression after merge;
- escalation to `critical` when necessary.

### CRITICAL

Use for migrations, authentication/authorization/security, finance/payments/billing, CI/workflows, infrastructure, shared domain/config packages, dependency manifests/locks, and unknown paths.

- full PR regression;
- independent audit;
- maximum 3 implementation attempts;
- 80 AI turns / 500 AI Credits per worker run;
- escalation to a human rather than an unbounded retry loop.

Protected governance files remain blocked from agent publication in this migration phase. They continue through the existing controlled path until an explicit approval workflow is introduced.

## Provider execution

The user-facing selection remains only **provider + risk**. Internally the dispatcher resolves that pair to one compiled worker. There are three provider families and three risk variants because `max-ai-credits` is a compile-time gh-aw guardrail:

```text
copilot × fast|standard|critical
codex   × fast|standard|critical
claude  × fast|standard|critical
```

`Delivery V2 - Dispatch` builds the deterministic plan and dispatches exactly one `.lock.yml` worker. A failed dispatch never falls back to another provider.

All workers use the same compact implementation contract: read the target issue, find the smallest cause, make the smallest cohesive fix, add a regression test when practical, run only profile-appropriate local checks, and create one reviewable PR. They do **not** invoke `entregar-issue`, `auditar-issue`, or another full orchestration Skill.

### Credential isolation

The agent receives `DELIVERY_GITHUB_READ_TOKEN` for cross-repository checkout and GitHub reads. `DELIVERY_GITHUB_WRITE_TOKEN` is referenced only by `safe-outputs`, which applies and publishes the resulting PR after the agent run. Shell access inside the agent therefore does not receive the write credential.

Provider inference prerequisites in the `delivery-orchestrator` repository:

- Copilot: access to `copilot-requests: write` (or supported Copilot token configuration);
- Codex: `CODEX_API_KEY` or `OPENAI_API_KEY`;
- Claude: `ANTHROPIC_API_KEY` or Anthropic WIF configured separately.

Missing provider authentication is a hard failure for that provider; no provider substitution is performed.

## gh-aw compilation

Worker Markdown files are the source of truth. They are compiled with pinned `gh-aw v0.88.7` into `.lock.yml` workflows. The compiler setup action is pinned to commit `bde367913adeb3132f0a171594c88a17f4b7d08c`.

A branch workflow compiles changed worker sources and commits generated locks. PR CI recompiles in strict mode and requires zero diff, preventing hand-edited or stale lock files.

## Execution architecture

```text
Issue
  -> deterministic risk plan
  -> exact provider×risk gh-aw worker
  -> safe-output PR
  -> focused / affected / full deterministic CI
  -> optional or required independent audit
  -> exact-head release gate
  -> human merge
```

No worker exposes a merge safe output.

## Migration sequence

1. **Done:** provider/risk contract, budgets and observable plan workflow.
2. **Current:** provider×risk gh-aw implementation workers, deterministic dispatcher and compiled-lock verification.
3. Add adaptive CI reusable workflows (`fast`, `standard`, `critical`).
4. Pilot `controle_calorias` with FAST fixes while V1 remains available.
5. Migrate SolverFin and training-system after measured success-rate and duration improve.
6. Retire the V1 agent loop only after the V2 path is proven.

No phase enables automatic merge.
