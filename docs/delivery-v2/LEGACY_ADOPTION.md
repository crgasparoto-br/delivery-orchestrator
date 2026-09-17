# Legacy PR adoption and deterministic refreeze

The guard persists a `<!-- delivery-v2-legacy-adoption -->` comment for a uniquely
identified, trusted legacy PR without canonical V2 state. It records repository,
issue, PR, base/head refs and SHAs, author/association, a hash of the issue-binding
body, PR evidence URL and controller-run provenance. It never renames the PR,
force-pushes, opens a replacement PR or reserves initial implementation work.

Unknown facts use `null`. A trusted bootstrap lease proves only its implementation
counter, not zero historical audits or a material-producing worker. Its original
counter and comment reference survive adoption. A successful V2 bootstrap worker
with a managed PR retains the existing bootstrap-recovery route.

## Trusted continuation input

For `post-write-refreeze`, the authorized owner publishes exactly one PR comment
beginning with `<!-- delivery-v2-audit-continuation -->` followed by fenced JSON.
The author login **and** GitHub association must satisfy the existing trust policy.
All identity fields must match live GitHub facts. This structured request proves
the requested recovery scope; it does not attest independent approval and never
substitutes for the independent audit gate. Arbitrary issue prose, an old handoff
file or an untrusted comment cannot authorize the transition.

Example for the issue #105 reproducer (these identity fields are historical;
they must be replaced with current observed facts before any real publication):

```json
{
  "schemaVersion": 1,
  "repository": "crgasparoto-br/SolverFin",
  "issueNumber": 613,
  "pullRequestNumber": 660,
  "baseRef": "main",
  "baseSha": "47052e36dd1c3413095d8a8a37769677bff28d39",
  "headRef": "codex/613-budgets-multicurrency",
  "materialHeadSha": "70499851ee7a96734a447bc3de50f7da56b8bf50",
  "reason": "handoff-stale",
  "recovery_scope": "post-write-refreeze",
  "requires_refreeze": true,
  "next_phase": "finalize-after-ci",
  "reuseExactHeadCi": true
}
```

The source reference is constructed from the actual GitHub comment ID, not a
caller-supplied evidence URL. Multiple records, missing fields, untrusted authors,
wrong issue/PR/branch/SHA, or unsupported scopes fail closed.

## Refreeze and remaining gates

`Checkout PR branch` checks out the immutable adopted head into a separate
directory using read credentials without persisted credentials. The controller
only reads its Git HEAD; it executes no code from that candidate. The shared
canonical classifier evaluates observed PR paths. The persisted classifier has
the actual classifier identity, never `fingerprint=headSha`.

The CI record must be from the configured workflow in the same repository and
branch at exactly the material SHA, with a matching GitHub Actions check suite
and terminal-success run and check. A newer pending/failed run prevents reuse of
an older success. Ancestor/merge-preview SHA results are not material-head proof.
Without authorized reusable CI, the checkpoint selects `observe-ci` and remains
blocked; a later re-entry re-observes evidence without dispatching implementation.

Successful refreeze persists phase `post-write-refreeze`, the real CI references,
classification and continuation reference. It does **not** report release ready.
Independent audit, technical hygiene and any unknown historical audit budgets or
producer identity remain blocking. Once a complete, authoritative operational
state exists, the existing normal state/CI/audit/release path has precedence;
the adoption record remains provenance. No unknown count is silently converted
to zero merely to invoke a provider. Metrics with zero provider calls describe
only this deterministic refreeze, not unknown historical consumption.

State and evidence are observed again on every re-entry. Head or base drift clears
the freeze, CI and classifier, preserves counters/provenance, and requires fresh
exact-identity evidence. The live PR is rechecked after collection and before
persistence as well. The PR #122 conflict and historical escalation are fixtures,
not special cases or manually reset state in this implementation.

The guard requests write capability only when posting/updating adoption or
terminalizing an exhausted pre-material lease. Infrastructure conclusions are
recorded separately from unknown pre-material failures; no absent material
candidate is mislabeled as a functional rejection. Audit-remediation budgets and
normal release gates remain unchanged from PR #146.

The dispatcher also re-evaluates the guard after a failed initial-controller
stage, so exhaustion is persisted during failure finalization, not deferred to
an operator's next invocation. That finalizer cannot dispatch any provider or
reserve another attempt. A PR published after a terminal lease can still enter
explicit adoption with the original counter; it is not treated as a new initial
delivery or an implicitly successful bootstrap recovery.
