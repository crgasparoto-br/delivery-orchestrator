# Delivery Orchestrator

Autonomous `implement -> independent audit -> remediate -> independent audit` loop for GitHub issues.

The project embeds the current `entregar-issue`/`auditar-issue` skill families as a versioned worker catalog and runs them in separate Codex contexts. The orchestrator itself never calls an audit inside the implementer's thread.

## Runtime model

```text
workflow_dispatch
      |
      v
implementer Codex thread (WRITE token, implementation CODEX_HOME)
      |
      +--> entregar-issue -> material head + handoff child
      |
      X thread ends
      |
      +--> wait for exact handoff SHA GitHub Actions runs to become terminal
      |
      v
auditor Codex thread (READ token, audit-only CODEX_HOME, fresh clone)
      |
      +--> auditar-issue
      |
      +--> approved + release gate -> COMPLETE
      |
      +--> rejected -> findings persisted -> new implementer thread
```

Every cycle creates new context IDs. Audit and implementation never share a thread. A repeated rejected SHA plus repeated finding fingerprint stops as `NO_PROGRESS` instead of looping blindly.

## Required secrets

- `OPENAI_API_KEY`
- `DELIVERY_GITHUB_WRITE_TOKEN`: fine-grained token/GitHub App credential with write access to target repositories.
- `DELIVERY_GITHUB_READ_TOKEN`: separate credential with read-only access to target repositories.
- `AUDITOR_PRIVATE_KEY_B64`: optional but required for importable signed approval under the current audit contract.
- `AUDITOR_KEY_PASSWORD`: password for the auditor Ed25519 key.

Repository variables:

- `AUDITOR_KEY_ID`
- `TRUSTED_AUDITORS_PATH` when the trusted registry is external; otherwise the auditor looks for `trusted-auditors.json` in the target repository.
- `OPENAI_MODEL` (defaults to `gpt-5.6-sol`).

The GitHub-hosted workflow sets `CODEX_SANDBOX_MODE=danger-full-access` because the hosted Ubuntu runner used by the workflow can block the `bwrap`/user-namespace setup required by Codex `workspace-write`. This does not merge the worker identities: implementer and auditor still use separate Codex threads and `CODEX_HOME` directories; the auditor receives a read-only GitHub credential, works from a fresh clone, and the orchestrator rejects the audit if the candidate SHA or working tree changes. Local execution keeps `workspace-write` by default.

Before each independent audit, the control plane observes GitHub Actions for the exact `handoff_head_sha`. If runs appear, it waits until the observed run set is terminal and stable before creating the auditor context. This prevents a transient `in_progress` release gate from being misclassified as a terminal external block. If no runs appear during the discovery grace period, auditing proceeds and the auditor remains responsible for deciding applicability. The wait is bounded by `CI_WAIT_TIMEOUT_SECONDS` (default 1800), with `CI_DISCOVERY_GRACE_SECONDS`, `CI_POLL_INTERVAL_SECONDS`, and `CI_SETTLE_SECONDS` available for tuning.

## One-time auditor trust bootstrap

Run:

```bash
AUDITOR_KEY_PASSWORD='use-a-secret-manager' ./scripts/generate-auditor-trust.sh ./auditor-trust delivery-independent-auditor-v1 'owner/*'
```

Store `auditor-private.pem.b64` as the GitHub secret `AUDITOR_PRIVATE_KEY_B64`; publish only `auditor-public.pem`. The bootstrap also creates `trusted-auditors.json`; commit that public registry in the orchestrator repository (for example `trust/trusted-auditors.json`) or host it in another pre-established read-only location, then point `TRUSTED_AUDITORS_PATH` to it before the delivery starts. Scope the repository glob as narrowly as practical.

## Start a delivery

Run the **Independent delivery loop** GitHub Action and provide:

- target repository (`owner/repo`)
- issue number
- maximum cycles (default 6)

The job exits successfully only when a genuinely independent audit returns an approved verdict with its release gate satisfied. It does not merge or close the issue.

## Local validation

```bash
npm test
npm run validate
```

A live end-to-end run additionally requires `gh`, the Codex SDK dependency, the two GitHub credentials, an OpenAI API key, and the auditor trust material.
