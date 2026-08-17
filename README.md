# Delivery Orchestrator

Autonomous `implement -> independent audit -> remediate -> independent audit` loop for GitHub issues.

The project embeds the current `entregar-issue`/`auditar-issue` skill families as a versioned worker catalog. Implementation and audit run in fresh Codex contexts **and under different Linux users**, so model-level filesystem reads cannot cross role credential stores.

## Runtime model

```text
workflow_dispatch OR trusted delivery-request control issue
      |
      v
request normalization + actor/repository allowlists
      |
      v
trusted private self-hosted runner control plane
      |
      +--> sudo -> delivery-implementer
      |      Codex thread + WRITE token + implementer CODEX_HOME
      |      implementation clone under implementer UID
      |
      X implementer process exits
      |
      +--> observe exact handoff SHA CI
      |
      +--> materialize auditor signing key under auditor UID only
      |
      +--> sudo -> delivery-auditor
             Codex thread + READ token + auditor CODEX_HOME
             fresh audit clone under auditor UID
```

Every cycle creates new context IDs. The orchestrator rejects equal role users, equal `CODEX_HOME` paths, and any successful cross-role readability probe. The auditor signing key is not materialized until the implementer process has ended and is removed immediately after the audit call.

## Codex authentication

`CODEX_AUTH_MODE` supports two explicit modes:

- `chatgpt` (default): uses account authentication stored in persistent, role-specific `CODEX_HOME` directories. API credentials are removed from the Codex environment and the login method is forced to `chatgpt`.
- `api-key`: explicit compatibility fallback that requires `OPENAI_API_KEY` and forces the login method to `api`.

ChatGPT-managed automation is restricted to a trusted private runner and a private control repository. The workflow checks repository visibility at runtime and fails closed if the repository is public. Persistent `auth.json` files must be owned by their respective Linux role users and inaccessible to the opposite role.

References:

- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/auth/ci-cd-auth

### One-time Linux role bootstrap

Create two dedicated non-root users on the self-hosted runner. The GitHub Actions runner account must be able to execute commands as **only those two identities** without an interactive password; it does not need passwordless root access for normal orchestration.

Example, executed by a runner administrator:

```bash
sudo useradd --create-home --shell /bin/bash delivery-implementer
sudo useradd --create-home --shell /bin/bash delivery-auditor

runner_user="$(id -un)"
printf '%s ALL=(delivery-implementer,delivery-auditor) NOPASSWD: ALL\n' "$runner_user" \
  | sudo tee /etc/sudoers.d/delivery-orchestrator-roles >/dev/null
sudo chmod 440 /etc/sudoers.d/delivery-orchestrator-roles
```

The role names can be overridden with repository variables `DELIVERY_IMPLEMENTER_USER` and `DELIVERY_AUDITOR_USER`. They must remain distinct.

The isolated roles also require a shared Node.js runtime at `/usr/local/bin/node`, version 22 or newer. Do **not** point role execution at a runner-user NVM tree or the private `actions/setup-node` tool cache: those paths commonly live below the runner user's home and are intentionally not traversable by the isolated role users.

Validate the shared runtime before enabling delivery:

```bash
/usr/local/bin/node --version
sudo -u delivery-implementer -H /usr/local/bin/node --version
sudo -u delivery-auditor -H /usr/local/bin/node --version
```

The workflow uses `actions/setup-node` only for runner-owned checkout/bootstrap steps. Before role execution it stages the orchestrator code, SDK dependencies, skill catalog and Python virtualenv in an ephemeral read-only shared bundle under `/tmp/delivery-orchestrator-runtime-<run>-<attempt>`. The controller is then started with `/usr/local/bin/node` from that bundle, so `process.execPath`, the role worker, SDK imports, skills and Python tooling all resolve through paths both isolated roles can traverse. The bundle is removed only after forensic state upload.

The bootstrap script validates the shared Node runtime and shared Codex CLI executability for both role users:

```bash
sudo bash scripts/bootstrap-runner-roles.sh "$(id -un)"
```

### One-time ChatGPT auth bootstrap

Authenticate each role while already running as that role user. The default persistent homes are resolved from each user's own OS home:

- implementer: `~delivery-implementer/.codex-delivery/implementer`
- auditor: `~delivery-auditor/.codex-delivery/auditor`

```bash
sudo -u delivery-implementer -H bash -lc '
  mkdir -p "$HOME/.codex-delivery/implementer"
  chmod 700 "$HOME/.codex-delivery/implementer"
  printf "%s\n" "cli_auth_credentials_store = \"file\"" "forced_login_method = \"chatgpt\"" \
    > "$HOME/.codex-delivery/implementer/config.toml"
  CODEX_HOME="$HOME/.codex-delivery/implementer" codex login --device-auth
  chmod 600 "$HOME/.codex-delivery/implementer/auth.json"
'

sudo -u delivery-auditor -H bash -lc '
  mkdir -p "$HOME/.codex-delivery/auditor"
  chmod 700 "$HOME/.codex-delivery/auditor"
  printf "%s\n" "cli_auth_credentials_store = \"file\"" "forced_login_method = \"chatgpt\"" \
    > "$HOME/.codex-delivery/auditor/config.toml"
  CODEX_HOME="$HOME/.codex-delivery/auditor" codex login --device-auth
  chmod 600 "$HOME/.codex-delivery/auditor/auth.json"
'
```

Do not authenticate both homes as the runner account and rely on path separation. The runtime requires OS-user separation and performs reciprocal cross-read probes before starting Codex.

Optional repository variables:

- `CODEX_AUTH_MODE` (`chatgpt` by default).
- `DELIVERY_IMPLEMENTER_USER` and `DELIVERY_AUDITOR_USER`.
- `CODEX_IMPLEMENTER_HOME` and `CODEX_AUDITOR_HOME` when the persistent role homes use non-default paths.
- `CODEX_SANDBOX_MODE` (`workspace-write` by default).
- `OPENAI_MODEL` (defaults to `gpt-5.6-sol`).
- `AUDITOR_KEY_ID`.
- `TRUSTED_AUDITORS_PATH` when the trusted registry is external.
- `DELIVERY_REQUEST_ACTORS`: comma/space-separated GitHub logins allowed to create control issues. Defaults to the control repository owner.
- `DELIVERY_ALLOWED_REPOSITORIES`: comma/space-separated exact repositories or `owner/*` patterns accepted from control issues. Defaults to `<control-repository-owner>/*`.
- `DELIVERY_REQUEST_MAX_CYCLES`: maximum `max_cycles` accepted from control issues. Defaults to `12`.

## Credential boundary

Always required for live delivery:

- `DELIVERY_GITHUB_WRITE_TOKEN`: given only to the implementer Codex process.
- `DELIVERY_GITHUB_READ_TOKEN`: given only to the auditor Codex process.
- `AUDITOR_PRIVATE_KEY_B64`: required for importable signed approval under the current audit contract.
- `AUDITOR_KEY_PASSWORD`: passed only to the auditor process.

Only when `CODEX_AUTH_MODE=api-key`:

- `OPENAI_API_KEY`.

The parent runner environment is no longer inherited wholesale by Codex. Only a small operational allowlist plus explicitly selected role inputs is forwarded. Sensitive role payloads are delivered to the role worker over stdin rather than command-line arguments.

The auditor private key is created only after implementation and CI observation, under the auditor UID with mode `0600`. Before the audit begins, the orchestrator executes an implementer-role readability probe and fails closed if the key is readable. The key directory is removed immediately after the auditor call. Persistent ChatGPT homes remain outside run artifacts. Forensic state is written beneath the ephemeral shared control bundle and uploaded before that bundle is removed.

## Exact-head CI observation

Before each independent audit, the control plane observes GitHub Actions for the exact `handoff_head_sha`. The wait remains bounded by `CI_WAIT_TIMEOUT_SECONDS`, with discovery, polling and settle settings configurable. CI observation does not weaken the OS-user credential boundary.

## One-time auditor trust bootstrap

Run:

```bash
AUDITOR_KEY_PASSWORD='use-a-secret-manager' ./scripts/generate-auditor-trust.sh ./auditor-trust delivery-independent-auditor-v1 'owner/*'
```

Store `auditor-private.pem.b64` as `AUDITOR_PRIVATE_KEY_B64`; publish only the public key and trusted registry. Never place the private key in a repository, role `CODEX_HOME`, issue, PR, or artifact.

## Start a delivery

### Manual GitHub Actions dispatch

Run the **Independent delivery loop** GitHub Action and provide the target repository, issue number, and optional maximum cycle count.

### Trusted control issue

An authorized automation client that can create GitHub issues but cannot call `workflow_dispatch` can open an issue in this private control repository. The title must start with `delivery-request:` and the body must be a plain JSON object containing only the supported fields:

```json
{
  "target_repository": "crgasparoto-br/controle_calorias",
  "issue_number": 987,
  "max_cycles": 6
}
```

The workflow rejects the request before running the delivery loop when:

- the creator is not in `DELIVERY_REQUEST_ACTORS` (or is not the repository owner when the variable is unset);
- the target is outside `DELIVERY_ALLOWED_REPOSITORIES` (or outside the control repository owner's namespace by default);
- the title does not use the `delivery-request:` prefix;
- the JSON contains unsupported fields or invalid repository/issue/cycle values;
- `max_cycles` exceeds `DELIVERY_REQUEST_MAX_CYCLES` (12 by default).

Control-issue and manual requests both execute the same **Independent delivery loop** workflow, so run discovery, forensic artifacts, isolation guarantees and terminal-state handling remain unchanged. The job never merges or closes the target issue automatically.

## Local validation

```bash
npm test
npm run validate
```

A live end-to-end run additionally requires `gh`, a shared Node.js >=22 runtime at `/usr/local/bin/node`, Codex in a shared executable location, the two dedicated Linux users, the runner-to-role sudo policy, the two GitHub credentials, the selected Codex authentication mode, and auditor trust material.
