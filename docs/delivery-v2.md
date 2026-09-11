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
- `DELIVERY_AI_MODEL`, `DELIVERY_IMPLEMENTER_MODEL`, and `DELIVERY_AUDITOR_MODEL` optionally pin models.

Invalid providers fail closed. There is no automatic provider fallback.

GitHub Agentic Workflows (`gh-aw`) is the target execution runtime because it supports built-in `copilot`, `claude`, and `codex` engines and compiles Markdown sources into normal GitHub Actions workflows. Conventional GitHub Actions remain responsible for builds, tests, linting and other deterministic checks.

Official references:

- https://github.github.com/gh-aw/reference/engines/
- https://github.github.com/gh-aw/reference/faq/

## Risk profiles

`DELIVERY_RISK_PROFILE` accepts `auto`, `fast`, `standard`, or `critical`.

### FAST

Use for bounded presentation/UI fixes and documentation/styles when no sensitive path is touched.

- focused CI;
- maximum 2 implementation attempts;
- no mandatory LLM audit by default;
- full regression after merge;
- escalation to `standard` after the retry budget is exhausted.

### STANDARD

Use for ordinary application/API changes.

- affected tests plus build;
- maximum 2 implementation attempts;
- one focused independent audit;
- full regression after merge;
- escalation to `critical` when necessary.

### CRITICAL

Use for migrations, authentication/authorization/security, finance/payments/billing, CI/workflows, infrastructure, shared domain/config packages, dependency manifests/locks, and unknown paths.

- full PR regression;
- independent audit;
- larger but bounded AI budget;
- escalation to a human rather than an unbounded retry loop.

## Deterministic promotion

Risk can only stay the same or move upward after changed paths are known. Examples:

- an explicitly requested `fast` change that touches a migration becomes `critical`;
- an unknown path becomes `critical`;
- a presentation-only component may remain `fast`.

The AI model does not decide this promotion.

## V2 plan contract

Generate a plan locally or in Actions:

```bash
DELIVERY_AI_PROVIDER=claude \
DELIVERY_RISK_PROFILE=fast \
DELIVERY_CHANGED_PATHS='apps/web/src/components/Filter.tsx' \
node src/cli.mjs plan-v2 --repo owner/repo --issue 123
```

The JSON result records provider, risk, budgets, CI mode, audit requirements and the invariant `noAutomaticMerge=true`.

The manual workflow `Delivery V2 - Plan` exposes provider and risk as GitHub inputs and uploads the resulting JSON plan. It does not invoke an AI yet; it is the control-plane foundation for the next migration step.

## Execution architecture

Target flow:

```text
Issue / PR
  -> deterministic risk classification
  -> provider-specific gh-aw workflow (copilot | codex | claude)
  -> focused or full deterministic CI based on risk
  -> optional/required independent audit based on risk
  -> exact-head release gate
  -> human merge
```

The `engine` is an Agentic Workflow frontmatter setting. Runtime provider selection will therefore be implemented by a deterministic dispatcher choosing among compiled provider-specific workflows rather than asking an LLM to switch engines.

## Migration sequence

1. Foundation: provider/risk contract, budgets and observable plan workflow.
2. Add three small provider-specific `gh-aw` implementation workflows and compile their `.lock.yml` files.
3. Add adaptive CI reusable workflows (`fast`, `standard`, `critical`).
4. Pilot one repository with FAST fixes while V1 remains fallback.
5. Migrate the other repositories after measured success-rate and duration improve.
6. Retire the V1 agent loop only after the V2 path is proven.

No phase enables automatic merge.
