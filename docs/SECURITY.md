# Security and independence model

Implementation and audit are separated on five axes:

1. **Context** — every phase uses a fresh Codex thread; prior threads are never resumed.
2. **OS process identity** — implementer and auditor execute as different non-root Linux users through non-interactive `sudo -u` from the trusted runner control plane.
3. **Codex identity** — each Linux user owns a separate persistent `CODEX_HOME`; the runtime rejects equal paths and performs reciprocal readability probes against `auth.json`.
4. **Workspace** — implementation and audit use different clones created by their respective role users. The audit clone is detached at the certified handoff SHA and verified clean after the audit.
5. **Credentials** — the write token is explicit only for the implementer, the read token is explicit only for the auditor, and the signing key exists only during the auditor phase.

## Why Codex sandboxing is not the credential boundary

`workspace-write` limits writes but is not treated as a filesystem confidentiality boundary. Role credential isolation therefore does not depend on hiding sibling paths or on Codex sandbox read restrictions. The security boundary is the Linux UID plus restrictive filesystem ownership/modes, verified with negative cross-role read probes before model execution.

## Environment boundary

The Codex environment is built from a small operational allowlist rather than inheriting the runner's complete `process.env`. Raw orchestration variables and API/access-token variables are stripped. The implementer additionally cannot receive auditor key password, key ID, output directory or trusted-auditor path through its explicit environment.

Role payloads, including GitHub tokens and API-key fallback material, are sent to the role worker over stdin. They are not appended to `sudo`, `node`, `gh` or Git command lines.

## ChatGPT authentication boundary

`CODEX_AUTH_MODE=chatgpt` preserves each role's credential cache because Codex refreshes `auth.json` in place. Each persistent home is prepared by its owning role user, mode `0700`; `auth.json` is mode `0600`. The opposite role must fail an `R_OK` probe against that file before the delivery proceeds.

The workflow is restricted to trusted private automation and checks repository visibility at runtime. A public repository, missing role user, interactive sudo requirement, missing refreshable auth cache, shared role identity, shared home or successful cross-role auth read fails closed.

`CODEX_AUTH_MODE=api-key` remains explicit and requires `OPENAI_API_KEY`. Temporary role homes are still created under separate Linux users, so API-key mode does not silently collapse the process boundary.

## Auditor signing material

The signing private key is never prepared before implementation. After the implementer process has exited and exact-head CI has been observed, the orchestrator asks the auditor role worker to decode the key into the auditor runtime directory with mode `0600`. It then executes a negative read probe as the implementer user; any readable result aborts the audit.

The key directory is removed in a `finally` path immediately after the auditor Codex call. It is never stored in persistent `CODEX_HOME`, the implementation workspace, repository files, issue/PR text, or forensic artifacts.

## Trusted control plane and sudo scope

The GitHub Actions runner process is the trusted orchestration control plane and necessarily receives the configured secrets. Its sudo policy should grant passwordless impersonation only to the dedicated implementer and auditor users, not passwordless root. Neither role user receives a sudo rule allowing it to become the other role.

## Fail-closed conditions

The orchestrator fails closed when any of these occur:

- implementer and auditor Linux users are equal or invalid;
- role `CODEX_HOME` paths are equal;
- either role cannot prepare/read its own credential store;
- either role can read the other role's credential store;
- the implementer can read the materialized auditor signing key;
- role worker execution requires interaction or fails;
- implementation/audit context IDs are equal;
- handoff identity is missing or the audit workspace changes;
- the audit is inconclusive or release gating is not independently satisfied;
- the same rejected identity/finding fingerprint repeats without progress.
