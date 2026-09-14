# Delivery V2 — AI provider and model configuration

Delivery V2 resolves the implementation/remediation AI and the independent-audit AI from **GitHub Actions Variables**. Provider/model choices are operational configuration; credentials remain **GitHub Actions Secrets**.

## Resolution rules

The effective risk (`fast`, `standard`, or `critical`) is determined first. Provider and model are then resolved deterministically.

For implementation/remediation:

1. risk-specific implementation variable;
2. general implementation variable;
3. versioned orchestrator default.

For independent audit:

1. risk-specific audit variable (`standard` or `critical`);
2. general audit variable;
3. versioned orchestrator default.

There is no silent provider or model substitution. If the configured provider/model cannot be invoked, that attempt fails closed instead of switching to another provider/model.

## GitHub Actions Variables

Configure these under **Settings → Secrets and variables → Actions → Variables** in `delivery-orchestrator`.

| Variable | Purpose |
| --- | --- |
| `DELIVERY_IMPLEMENTER_PROVIDER` | General implementation/remediation provider |
| `DELIVERY_IMPLEMENTER_MODEL` | General implementation/remediation model |
| `DELIVERY_AUDITOR_PROVIDER` | General independent-audit provider |
| `DELIVERY_AUDITOR_MODEL` | General independent-audit model |
| `DELIVERY_FAST_IMPLEMENTER_PROVIDER` | FAST implementation provider override |
| `DELIVERY_FAST_IMPLEMENTER_MODEL` | FAST implementation model override |
| `DELIVERY_STANDARD_IMPLEMENTER_PROVIDER` | STANDARD implementation provider override |
| `DELIVERY_STANDARD_IMPLEMENTER_MODEL` | STANDARD implementation model override |
| `DELIVERY_CRITICAL_IMPLEMENTER_PROVIDER` | CRITICAL implementation provider override |
| `DELIVERY_CRITICAL_IMPLEMENTER_MODEL` | CRITICAL implementation model override |
| `DELIVERY_STANDARD_AUDITOR_PROVIDER` | STANDARD audit provider override |
| `DELIVERY_STANDARD_AUDITOR_MODEL` | STANDARD audit model override |
| `DELIVERY_CRITICAL_AUDITOR_PROVIDER` | CRITICAL audit provider override |
| `DELIVERY_CRITICAL_AUDITOR_MODEL` | CRITICAL audit model override |

Supported provider values are `codex`, `claude`, and `copilot`.

FAST has no mandatory LLM audit, so there are no FAST auditor variables.

## Versioned defaults

Defaults are concrete model identifiers rather than `auto`/`agent` aliases so that an unconfigured run remains reproducible.

| Role | Default provider | Codex model | Claude model | Copilot model |
| --- | --- | --- | --- | --- |
| Implementation/remediation | `copilot` | `gpt-5.4` | `claude-sonnet-5` | `gpt-5.3-codex` |
| Independent audit | `codex` | `gpt-5.6-sol` | `claude-opus-5` | `gpt-5.3-codex` |

Changing a GitHub Variable affects a subsequent controller run. Within one controller cycle, the resolved auditor provider/model is persisted in the Delivery V2 state before audit dispatch. The independent-audit workflow re-resolves the applicable Variables only as a drift check: if provider or model differs from the frozen controller identity, the audit fails before any provider invocation instead of silently switching identity.

## Secrets and authentication

Do not place credentials in GitHub Variables. Use GitHub Actions Secrets for authentication:

- Codex/OpenAI: `OPENAI_API_KEY` when API-key authentication is selected, or the isolated Codex ChatGPT credential already provisioned for the auditor runtime;
- Claude: `ANTHROPIC_API_KEY`;
- Copilot audit runtime: `COPILOT_GITHUB_TOKEN`;
- GitHub repository reads/writes: the existing Delivery V2 GitHub tokens.

A selected provider with missing authentication is a blocking configuration error. The orchestrator does not retry with a different provider.

## Example

A cost-sensitive configuration can use Copilot for routine implementation while reserving stronger independent review for critical changes:

```text
DELIVERY_FAST_IMPLEMENTER_PROVIDER=copilot
DELIVERY_FAST_IMPLEMENTER_MODEL=gpt-5.3-codex

DELIVERY_STANDARD_IMPLEMENTER_PROVIDER=codex
DELIVERY_STANDARD_IMPLEMENTER_MODEL=gpt-5.4
DELIVERY_STANDARD_AUDITOR_PROVIDER=claude
DELIVERY_STANDARD_AUDITOR_MODEL=claude-sonnet-5

DELIVERY_CRITICAL_IMPLEMENTER_PROVIDER=codex
DELIVERY_CRITICAL_IMPLEMENTER_MODEL=gpt-5.6-sol
DELIVERY_CRITICAL_AUDITOR_PROVIDER=claude
DELIVERY_CRITICAL_AUDITOR_MODEL=claude-opus-5
```

The example is not a forced policy. Repository variables are the operator-controlled choice.

## Evidence

The deterministic plan records the resolved implementation and audit provider/model. Compiled implementation workers expose the actual selected model in GitHub Actions workflow outputs. Before an independent audit provider is called, the workflow proves that its currently resolved audit provider/model still matches the exact controller state for the target repository, issue, PR head, risk, and audit dispatch nonce. The audit artifact persists the same identity in both top-level `auditRuntime` and `result.auditRuntime`, so the authoritative result consumed by the controller retains the provider/model that actually ran.
