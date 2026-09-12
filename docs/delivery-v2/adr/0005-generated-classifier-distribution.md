# ADR 0005 — Generated classifier distribution

- Status: Accepted
- Date: 2026-09-12

## Decision

Because `delivery-orchestrator` is private and public repositories cannot directly consume its private reusable action/workflow, the official V2 distribution model is generated vendoring.

The orchestrator will export a self-contained classifier/policy package into target repositories with source version, policy fingerprint, target overrides, and a verifier.

## Consequences

- No need to make the orchestrator public.
- Public/private repositories receive identical traceable core policy.
- Target-specific configuration can promote risk and define reviewed safe roots without duplicating core logic.
- Generated drift is detectable and updateable through normal PRs.
