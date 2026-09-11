# Delivery V2: GitHub-native, risk-adaptive delivery

## Goal

Move orchestration decisions out of the coding model. GitHub Actions owns deterministic state, CI, budgets, SHA identity and release gates. An AI engine is invoked only for work that needs reasoning or code generation.

V1 remains available during migration. V2 does not silently fall back to V1 or to a different AI provider.

## Provider selection

V2 accepts these providers:

- `copilot` — GitHub Copilot CLI engine;
- `codex` — OpenAI Codex engine;
- `claude` — Anthropic Claude Code engine.

Invalid providers fail closed. There is no automatic provider fallback.

GitHub Agentic Workflows (`gh-aw`) is the execution runtime. Conventional GitHub Actions remain responsible for builds, tests, linting and other deterministic checks.

## Risk profiles

`DELIVERY_RISK_PROFILE` accepts `auto`, `fast`, `standard`, or `critical`.

### FAST
- focused CI;
- max 2 implementation attempts;
- 20 AI turns / 100 AI Credits;
- no mandatory LLM audit by default;
- full regression after merge.

FAST workers use a safe-output file allowlist. If broader paths are required, publication fails closed.

### STANDARD
- affected tests plus build;
- max 2 implementation attempts;
- 40 AI turns / 250 AI Credits;
- focused independent audit.

### CRITICAL
- full PR regression;
- independent audit;
- max 3 implementation attempts;
- 80 AI turns / 500 AI Credits;
- human escalation instead of unbounded retries.

Protected governance files remain blocked from agent publication in this migration phase.

## Provider execution

The user-facing selection remains **provider + risk**. Internally the dispatcher resolves that pair to one compiled worker. There are three provider families and three risk variants because `max-ai-credits` is a compile-time gh-aw guardrail:

```text
copilot × fast|standard|critical
codex   × fast|standard|critical
claude  × fast|standard|critical
```

`Delivery V2 - Dispatch` builds the deterministic plan and dispatches exactly one `.lock.yml` worker. Failed provider dispatches never fall back to another provider.

Workers use a compact contract: read the issue, identify the smallest cause, make the smallest cohesive fix, add regression coverage when practical, run profile-appropriate checks, and create one reviewable PR. They do not invoke full orchestration Skills.

### Credential isolation

The agent receives `DELIVERY_GITHUB_READ_TOKEN` for cross-repository checkout and reads. `DELIVERY_GITHUB_WRITE_TOKEN` is referenced only by `safe-outputs`, so agent shell access does not receive the write credential.

Provider inference prerequisites in `delivery-orchestrator`:
- Copilot: `copilot-requests: write` or supported Copilot token configuration;
- Codex: `CODEX_API_KEY` or `OPENAI_API_KEY`;
- Claude: `ANTHROPIC_API_KEY` or Anthropic WIF.

Missing provider authentication is a hard failure; there is no provider substitution.

## gh-aw compilation

Worker Markdown sources are compiled with pinned `gh-aw v0.88.7` into `.lock.yml`. The setup action is pinned to `bde367913adeb3132f0a171594c88a17f4b7d08c`.

Branch automation compiles changed worker sources and commits generated locks. PR CI recompiles in strict mode and requires zero diff.

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
1. **Done:** provider/risk contract, budgets and plan workflow.
2. **Current:** provider×risk gh-aw workers, deterministic dispatcher and compiled-lock verification.
3. Add adaptive CI reusable workflows.
4. Pilot `controle_calorias` with FAST fixes while V1 remains available.
5. Migrate SolverFin and training-system after measured improvement.
6. Retire V1 only after V2 is proven.

No phase enables automatic merge.
