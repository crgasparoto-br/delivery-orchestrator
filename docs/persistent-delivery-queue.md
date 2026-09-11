# Persistent delivery queue

## Purpose

The control repository uses open `delivery-request:` issues as durable queue records for autonomous deliveries. GitHub Actions remains globally serialized because the ChatGPT/Codex auth cache is shared by the runner, but a pending workflow cancellation no longer means the delivery request is lost.

Capability discovery is published in `.github/delivery-orchestrator-capabilities.json`. Clients must enable persistent-queue behavior only when `persistent_control_queue` is `v1` on the repository default branch.

## Queue lifecycle

1. An authorized client opens one `delivery-request:` issue with the existing strict JSON body contract.
2. The issue remains open while its delivery is waiting or running.
3. `delivery-loop.yml` consumes the request and preserves the original control issue identity when the queue pump re-dispatches it.
4. A request cancelled before consumption remains open and therefore remains queued.
5. After a delivery attempt is actually consumed, the workflow comments the outcome and closes only the control issue, never the target issue.
6. The queue pump selects the oldest remaining open request and dispatches it when no other live delivery run owns the serialized worker.

Clients must deduplicate by target repository, target issue and current material head identity before opening another queue item. Opening another issue merely to wake the queue is prohibited.

## Canonical pull request binding

Before cloning the target repository, the runner resolves open pull requests related to the target issue. An explicit closing reference has stronger precedence than a generic related reference or branch-name match.

When a reusable PR is found, its number, head branch and head SHA are bound into the delivery runtime. The implementer clone starts directly on that branch and the prompt forbids replacement branches or additional PRs. CI failures, audit rejection and stale handoff state are remediation conditions on the same PR; they are not reasons to create a new PR.

If multiple PRs are equally plausible, the runner fails closed with a PR-binding ambiguity instead of creating another candidate.

## Safety

- The target issue is never closed by queue bookkeeping.
- The target PR is never merged automatically.
- Independent audit still runs under the isolated auditor identity.
- The global delivery concurrency group remains serialized.
- Queue persistence is based on GitHub issue state, not ephemeral workflow-pending state.
