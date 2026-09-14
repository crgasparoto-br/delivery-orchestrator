# ADR 0002 — Bounded provider/model execution with no silent fallback

- Status: Accepted
- Date: 2026-09-12
- Amended: 2026-09-14

## Decision

Provider and model choice are explicit control-plane facts. Supported providers are `codex`, `claude`, and `copilot`; implementation/remediation provider/model and independent-audit provider/model are resolved separately after effective risk is known.

Operational choice is configured through GitHub Actions Variables in `delivery-orchestrator`. Resolution precedence is risk-specific role variable, then general role variable, then a concrete versioned default. Mutable model aliases such as `auto`/`agent` are not versioned defaults.

The resolved implementation provider and risk select one pinned worker. Missing authentication, unsupported provider, invalid/unavailable configured model, or provider failure fails that attempt; the controller never silently substitutes another provider or model.

AI work is bounded by implementation/audit attempt ceilings, turns, credits, timeouts, repository allowlists, and safe-output permissions. Credentials remain GitHub Actions Secrets rather than Variables.

## Consequences

- The operator can change AI/provider/model policy without editing workflow source.
- Provider/model behavior and cost are observable instead of hidden behind fallback.
- Past workflow/audit evidence retains the provider/model actually used even after Variables change.
- A failed provider/model can be retried only according to explicit policy; it is never silently replaced.
- Exhausted budgets escalate to a human.
- Agent shell execution does not receive a general privileged write token.

See `docs/delivery-v2/AI_CONFIGURATION.md` for the variable matrix, precedence, current concrete defaults, and credential mapping.
