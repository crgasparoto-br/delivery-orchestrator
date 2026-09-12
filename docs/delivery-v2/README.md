# Delivery V2 contract index

This directory is the durable architectural memory for Delivery V2.

Read in this order:

1. [`MASTER_SPEC.md`](./MASTER_SPEC.md) — canonical architecture and invariants.
2. [`../../config/delivery-v2-requirements.json`](../../config/delivery-v2-requirements.json) — machine-readable requirement/status/evidence projection.
3. [`ROADMAP.md`](./ROADMAP.md) — implementation order and exit criteria.
4. GitHub issue #27 — operational umbrella and cross-repository rollout.

Run `npm run verify:v2` after changing any of these sources.

## Architecture decisions

- [`adr/0001-deterministic-github-control-plane.md`](./adr/0001-deterministic-github-control-plane.md)
- [`adr/0002-bounded-provider-execution.md`](./adr/0002-bounded-provider-execution.md)
- [`adr/0003-risk-adaptive-ci-and-audit.md`](./adr/0003-risk-adaptive-ci-and-audit.md)
- [`adr/0004-github-native-audit-evidence.md`](./adr/0004-github-native-audit-evidence.md)
- [`adr/0005-generated-classifier-distribution.md`](./adr/0005-generated-classifier-distribution.md)

## Rule for future contexts

Do not depend on a previous chat transcript to reconstruct the design. If a decision is important enough to affect implementation, safety, cost, or release behavior, it belongs in the master specification, the requirements manifest, or an ADR.
