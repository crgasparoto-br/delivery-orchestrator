# Delivery V2 Chat ingress

ChatGPT-facing delivery commands must enter Delivery V2 through the deterministic controller. They must not implement a configured target repository directly and then attempt to bolt on an audit afterwards.

## Supported connector boundary

When the client cannot call GitHub `workflow_dispatch` directly, create an issue in `crgasparoto-br/delivery-orchestrator` with a title beginning with:

```text
[delivery-v2-dispatch]
```

The issue body must be a JSON object:

```json
{
  "target_repository": "crgasparoto-br/training-system",
  "target_issue": 447,
  "base_branch": "develop",
  "risk_profile": "auto",
  "changed_paths": []
}
```

Only an issue opened by the repository owner is accepted. The ingress validates the payload fail-closed and dispatches `.github/workflows/delivery-v2-dispatch.yml`. It does not invoke implementation workers, the controller script, CI remediation or the auditor directly.

After a successful dispatch, the command issue is closed automatically. Durable delivery state belongs to the managed target PR and the Delivery V2 controller. The controller remains responsible for provider/model resolution, implementation/remediation, exact-head CI, risk-required independent audit and the release gate.

## Invariant

For repositories configured in `config/delivery-v2-controller-targets.json`, a ChatGPT `@Entregar Issue` entrypoint is considered correctly routed only when it creates this ingress request (or invokes `Delivery V2 - Dispatch` through an equivalent trusted connector capability). A local skill implementation is not equivalent to a Delivery V2 run merely because the target repository has been onboarded.
