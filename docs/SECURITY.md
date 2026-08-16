# Security and independence model

The implementation and audit actors are intentionally separated on four axes:

1. **Context** — every phase uses `Codex.startThread()`; a prior implementation/audit thread is never resumed.
2. **Skill catalog and Codex identity** — separate `CODEX_HOME` directories expose implementation skills to the implementer and audit skills to the auditor. The orchestrator rejects identical role-home paths.
3. **Filesystem** — the implementer runs with the configured sandbox against its implementation clone; the auditor runs against a fresh detached clone of the certified handoff SHA and the orchestrator verifies the candidate head and working tree after the audit.
4. **Credentials** — `DELIVERY_GITHUB_WRITE_TOKEN` is given only to the implementer; `DELIVERY_GITHUB_READ_TOKEN` and the auditor signing key are given only to the auditor.

## Codex authentication boundary

`CODEX_AUTH_MODE=chatgpt` is explicit and fail-closed. Before constructing the Codex SDK client, the executor removes `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` from the child environment and forces `forced_login_method=chatgpt`. This prevents an unrelated API credential present on the runner from silently changing the billing/authentication path.

The ChatGPT mode preserves the role-specific `CODEX_HOME` roots because `auth.json` is a mutable credential cache that Codex refreshes in place. Only the `skills/` subdirectory is rebuilt for each run. Implementer and auditor must use different homes and should be authenticated independently.

`auth.json` is a secret equivalent to a password. It must remain on trusted private runner storage with restrictive filesystem permissions and must never be committed, logged, placed in a run artifact, copied into an issue/PR, or shared between concurrent machines/jobs. The GitHub workflow serializes runs for this reason and refuses ChatGPT-managed auth when the control repository is public.

`CODEX_AUTH_MODE=api-key` remains available as an explicit fallback. It requires `OPENAI_API_KEY`; the executor forces `forced_login_method=api` so the selected mode cannot silently fall through to an account session.

## Auditor signing material

The auditor private key must be generated independently and its public key trusted before the delivery being audited. Never place the private key in a repository, issue, PR, skill ZIP, run artifact, persistent ChatGPT `CODEX_HOME`, or implementer environment.

The orchestrator materializes the key only under the per-run runtime directory. The self-hosted workflow deletes all `runs/**/runtime` directories before uploading forensic run state and excludes those paths from the artifact definition as a second guard.

The orchestrator fails closed when context IDs are equal, role `CODEX_HOME` paths are equal, the handoff identity is missing, the audit is inconclusive, release gating is not independently satisfied, or the same rejected identity/finding fingerprint repeats without progress.
