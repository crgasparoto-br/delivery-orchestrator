# Delivery completion contract

The control plane is responsible for completing the delivery loop, not only starting it.

## Skill catalog synchronization

Worker Skills are versioned under `skills/catalog`. Before a delivery is dispatched from ChatGPT Web, the `orquestrar-entrega` controller synchronizes the installed worker Skills into this catalog and regenerates `skills/catalog.sync-manifest.json`.

The manifest is deterministic: each Skill records a SHA-256 digest derived from every relative file path and file content hash, plus its file count. `npm run validate` verifies exact catalog membership, count and digest before the workflow prepares role-specific `CODEX_HOME` directories. Catalog drift therefore fails closed instead of silently running an older Skill.

The synchronization source currently covers:

- implementer: `entregar-issue`, `revisar-issue`, `fluxos-conversacionais`, `documentacao-repositorio`, `design-interface`, `corrigir-ci`;
- auditor: `auditar-issue`, `fluxos-conversacionais`, `documentacao-repositorio`, `design-interface`.

`scripts/build_catalog_manifest.py` under the versioned `orquestrar-entrega` Skill can generate the manifest from the ChatGPT Web installed-Skills root. The GitHub runner does not have direct access to that private Web filesystem; the synchronized repository snapshot is the runtime source of truth.

## Exact-head CI remediation

For every candidate handoff, the orchestrator waits for GitHub Actions runs attached to the exact `handoff_head_sha` to reach a settled terminal state before independent audit.

`success`, `neutral` and `skipped` conclusions are non-blocking. Any other completed conclusion is a delivery failure signal. The controller records the failing workflows, transitions to `CI_FAILED`, and starts a remediation cycle instead of invoking the auditor.

The next implementer context receives the exact-head CI failures and must use the installed `corrigir-ci` Skill to inspect jobs/logs, correct the root cause, validate, publish a new candidate and restore a certified handoff. Only a candidate without blocking exact-head CI conclusions may proceed to independent audit.

A repeated identical CI failure fingerprint on the same material head is treated as `NO_PROGRESS` rather than consuming audits indefinitely. CI observation timeout or inability to query GitHub is `BLOCKED_EXTERNAL`.

## Human merge release signal

A delivery is not presented as ready for human merge merely because the implementation loop reached `COMPLETE`. Before the CLI returns success, it resolves the current PR for the target issue and revalidates that the PR is still open and that its head SHA exactly matches the independently audited `handoff_head_sha`.

A merge-release signal is published only when the audit result is `approved` or `approved_with_reservations`, `validity=independent`, and `release_gate_satisfied=true`. The orchestrator then creates or updates one idempotent PR conversation comment containing the audit verdict, `material_head_sha`, validated `handoff_head_sha`, and the explicit state `ready-for-human-merge`.

The signal is valid only for that exact PR head. Any later commit invalidates it and requires another independent audit. If the PR cannot be resolved unambiguously, is no longer open, has moved to a different head, or the release comment cannot be published, the final run state is changed from `COMPLETE` to `FAILED` and the release signal evidence records the reason. The workflow therefore cannot report success while the visible merge authorization is stale or absent.

This signal is informational authorization for a human merge. It never performs the merge itself.

## Outer workflow completion

`orquestrar-entrega` is the external controller and has a narrow polling exception: after correlating a single `Independent delivery loop` run, it follows that same run until terminal. It does not dispatch a second run while the correlated one is active.

If the control workflow itself fails, the controller reads jobs, steps, logs and forensic artifacts and reports or remediates the actual control-plane cause. This exception does not relax the implementer's rule against active CI polling inside `entregar-issue`.

No part of this contract authorizes automatic merge or automatic closure of the target issue.
