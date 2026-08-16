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

## Codex authentication

`CODEX_AUTH_MODE` supports two explicit modes:

- `chatgpt` (default): uses Codex account authentication stored in persistent, role-specific `CODEX_HOME` directories. API credentials are removed from the Codex child environment and the login method is forced to `chatgpt`.
- `api-key`: compatibility fallback that requires `OPENAI_API_KEY` and forces the Codex login method to `api`. Usage is billed through the OpenAI Platform account.

The ChatGPT mode follows OpenAI's advanced CI/CD pattern: a trusted self-hosted runner keeps `auth.json` on disk so Codex can refresh it in place. OpenAI explicitly limits this pattern to trusted private automation and says not to use it for public/open-source repositories. Therefore the workflow fails closed in `chatgpt` mode while this control repository is public. Make the control repository private before enabling account-authenticated automation.

References:

- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/auth/ci-cd-auth

### One-time ChatGPT auth bootstrap

Use a dedicated Linux self-hosted runner with the `delivery-orchestrator` label. The default role homes are:

- implementer: `$HOME/.codex-delivery/implementer`
- auditor: `$HOME/.codex-delivery/auditor`

Authenticate each home independently so they do not share an `auth.json` refresh stream:

```bash
mkdir -p "$HOME/.codex-delivery/implementer" "$HOME/.codex-delivery/auditor"
chmod 700 "$HOME/.codex-delivery/implementer" "$HOME/.codex-delivery/auditor"

printf '%s\n' 'cli_auth_credentials_store = "file"' 'forced_login_method = "chatgpt"' \
  > "$HOME/.codex-delivery/implementer/config.toml"
printf '%s\n' 'cli_auth_credentials_store = "file"' 'forced_login_method = "chatgpt"' \
  > "$HOME/.codex-delivery/auditor/config.toml"

CODEX_HOME="$HOME/.codex-delivery/implementer" codex login --device-auth
CODEX_HOME="$HOME/.codex-delivery/implementer" codex login status

CODEX_HOME="$HOME/.codex-delivery/auditor" codex login --device-auth
CODEX_HOME="$HOME/.codex-delivery/auditor" codex login status

chmod 600 "$HOME/.codex-delivery/implementer/auth.json" \
          "$HOME/.codex-delivery/auditor/auth.json"
```

Browser-based `codex login` can be used instead of device auth when the runner environment supports it. Do not commit, log, upload, or routinely reseed either `auth.json`; Codex must be allowed to persist its refreshed copy.

The workflow is serialized because a given `auth.json` must not be shared by concurrent jobs or machines. The implementation and auditor still use different homes, contexts, GitHub credentials, workspaces, and skill catalogs.

Optional repository variables:

- `CODEX_AUTH_MODE` (`chatgpt` by default; set `api-key` for the fallback).
- `CODEX_IMPLEMENTER_HOME` and `CODEX_AUDITOR_HOME` to override the persistent role homes.
- `CODEX_SANDBOX_MODE` (`workspace-write` by default on the self-hosted runner).
- `OPENAI_MODEL` (defaults to `gpt-5.6-sol`).
- `AUDITOR_KEY_ID`.
- `TRUSTED_AUDITORS_PATH` when the trusted registry is external; otherwise the auditor looks for `trusted-auditors.json` in the target repository.

## Required secrets

Always required for live delivery:

- `DELIVERY_GITHUB_WRITE_TOKEN`: fine-grained token/GitHub App credential with write access to target repositories.
- `DELIVERY_GITHUB_READ_TOKEN`: separate credential with read-only access to target repositories.
- `AUDITOR_PRIVATE_KEY_B64`: optional at runtime but required for importable signed approval under the current audit contract.
- `AUDITOR_KEY_PASSWORD`: password for the auditor Ed25519 key.

Only when `CODEX_AUTH_MODE=api-key`:

- `OPENAI_API_KEY`.

The workflow removes `runs/**/runtime` before uploading forensic state, so cloned workspaces and the materialized auditor private key are not uploaded as artifacts. The persistent ChatGPT `CODEX_HOME` directories live outside `runs/` and are never included in the artifact upload.

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

A live end-to-end run additionally requires `gh`, the Codex SDK dependency, the two GitHub credentials, the selected Codex authentication mode, and the auditor trust material.
