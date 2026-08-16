# Security and independence model

The implementation and audit actors are intentionally separated on four axes:

1. **Context** — every phase uses `Codex.startThread()`; a prior implementation/audit thread is never resumed.
2. **Skill catalog** — separate `CODEX_HOME` directories expose implementation skills to the implementer and audit skills to the auditor.
3. **Filesystem** — the implementer runs `workspace-write`; the auditor runs `read-only` against a fresh detached clone of the certified handoff SHA.
4. **Credentials** — `DELIVERY_GITHUB_WRITE_TOKEN` is given only to the implementer; `DELIVERY_GITHUB_READ_TOKEN` and the auditor signing key are given only to the auditor.

The auditor private key must be generated independently and its public key trusted before the delivery being audited. Never place the private key in a repository, issue, PR, skill ZIP, run artifact, or implementer environment.

The orchestrator fails closed when context IDs are equal, the handoff identity is missing, the audit is inconclusive, release gating is not independently satisfied, or the same rejected identity/finding fingerprint repeats without progress.
