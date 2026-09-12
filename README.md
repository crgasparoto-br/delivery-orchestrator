# Delivery Orchestrator

Delivery V2 is the default and only active delivery architecture in this repository. It uses GitHub as the deterministic control plane for candidate identity, risk, CI, remediation budgets, independent audit and release evidence. AI providers are bounded workers; they do not recursively orchestrate other AI workers.

## Start a delivery

Use the **Delivery V2 - Dispatch** GitHub Actions workflow (`.github/workflows/delivery-v2-dispatch.yml`). Provide the target repository, issue, provider, risk profile and base branch. The workflow builds a deterministic plan and dispatches exactly one provider/risk worker.

The local deterministic planner is also the default CLI entrypoint:

```bash
npm run run -- --repo crgasparoto-br/example --issue 123 --provider codex --risk auto --path apps/web/src/App.tsx
```

Equivalent explicit command:

```bash
npm run plan:v2 -- --repo crgasparoto-br/example --issue 123 --provider codex --risk auto --path apps/web/src/App.tsx
```

Other V2 control-plane commands:

```bash
npm run resume:v2 -- --state-file /path/state.json --repo owner/repo --pr 123 --head-ref branch --remote-head <sha>
npm run metrics:v2 -- --metrics-file /path/metrics.json
npm run verify:v2
npm run verify:v2:complete
```

## Runtime model

```text
workflow_dispatch
      |
      v
Delivery V2 deterministic plan
      |
      +--> repository/risk classifier (fail closed)
      +--> provider+risk worker selection (no silent fallback)
      |
      v
bounded implementation attempt
      |
      v
exact-head adaptive CI
      |
      +--> FAST: focused checks, no mandatory LLM audit
      +--> STANDARD: affected checks + policy audit when required
      +--> CRITICAL: full regression + independent audit
      |
      v
bounded deterministic remediation state machine
      |
      v
exact-head release gate / human merge policy
```

Material head drift invalidates candidate-bound CI/audit evidence. Attempt budgets are defined by the effective risk profile; exhausted budgets escalate instead of opening another AI-on-AI loop.

## V1 retirement

**V1 is retired.** The former `delivery-loop.yml`, `delivery-request:` queue, `max_cycles` controller, recursive implement/audit loop, normal-path nested Skill controller and mandatory `.audit/entregar-issue` handoff/certificate dependency are not active entrypoints.

Historical `.audit/entregar-issue/**` evidence and `skills/catalog/**` snapshots are retained only for **historical traceability**. They are not runtime dependencies of a normal V2 delivery and must not be used to reconstruct current orchestration state.

There were no open legacy `delivery-request:` control issues when DV2-014 retirement began.

## Canonical contract

Architecture and requirement state are versioned in:

- `docs/delivery-v2/MASTER_SPEC.md` — normative architecture and invariants;
- `config/delivery-v2-requirements.json` — machine-readable requirement status/evidence;
- `docs/delivery-v2/ROADMAP.md` — rollout order and exit criteria;
- `docs/delivery-v2/adr/` — accepted architectural decisions;
- issue #27 — operational tracking mirror.

Do not infer architecture from old chat transcripts or retained V1 evidence.

## Security model

Workers do not receive a generic control-plane write token. GitHub Actions owns privileged mutations and publishes bounded safe outputs. CRITICAL independent review runs in a fresh reviewer context, on the exact candidate, with read-only repository evidence and no implementer hidden reasoning. See `docs/SECURITY.md` and the Delivery V2 ADRs for the current boundary.

## Validation

For changes to the control plane run:

```bash
npm test
npm run validate
npm run verify:v2
```

The program is complete only when:

```bash
npm run verify:v2:complete
```

passes on `main` and the DV2-014 retirement evidence remains valid.
