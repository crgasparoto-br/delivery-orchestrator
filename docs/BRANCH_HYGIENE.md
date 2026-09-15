# Branch hygiene on the VPS

Branch hygiene is deterministic and runs without ChatGPT, Skills, or an LLM. The functional scope comes only from `ORCHESTRATOR_REPOSITORIES`; the GitHub token only grants access to that configured scope.

## Configuration

Create `/etc/delivery-orchestrator/hygiene.env` from `deploy/systemd/hygiene.env.example` and set a comma-separated list of `owner/repository` values:

```bash
ORCHESTRATOR_REPOSITORIES=owner/repository-a,owner/repository-b
GITHUB_TOKEN=<fine-grained-token>
ORCHESTRATOR_HYGIENE_LOG_DIR=/var/log/delivery-orchestrator/branch-hygiene
```

An empty or invalid `ORCHESTRATOR_REPOSITORIES` aborts before mutation. Repositories are never discovered from token visibility.

For a Fine-grained PAT, grant repository **Contents: read and write** to each configured repository. Read access to metadata, pull requests, checks/actions, rules and commit comparison must also be available to the token. Do not grant administration merely for this routine. If any required endpoint is unavailable or inconclusive, the branch is preserved.

## Manual use

The default is non-destructive:

```bash
node src/cli.mjs hygiene --older-than 7d --dry-run
```

Apply only after validating dry-run output:

```bash
node src/cli.mjs hygiene --older-than 7d --apply
```

Use `--json` for structured stdout. Every run also persists a JSON audit file containing timestamp, repository, branch, evaluated SHA, age, each safety gate, decision, reason and any error. Human output separates removed/would-remove, safety-preserved and doubtful branches.

A branch can be removed only when it is older than the threshold, is not the default branch, `main` or `develop`, is not protected by branch protection/rulesets, has no open PR, has no non-terminal workflow/check, and has no unique commit compared with the applicable base (`develop` when present, otherwise the default branch). Any uncertain gate preserves the branch.

In `--apply`, the repository, branch list, SHA and all safety gates are re-read immediately before deletion. The delete uses GitHub's real `DELETE refs/heads/*` operation; force-updating a ref is never used as a substitute.

## systemd scheduling

Install the versioned units:

```bash
sudo install -d /etc/delivery-orchestrator /var/log/delivery-orchestrator/branch-hygiene
sudo cp deploy/systemd/hygiene.env.example /etc/delivery-orchestrator/hygiene.env
sudo cp deploy/systemd/delivery-orchestrator-branch-hygiene.service /etc/systemd/system/
sudo cp deploy/systemd/delivery-orchestrator-branch-hygiene.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

Run a dry-run manually first by temporarily changing the service command from `--apply` to `--dry-run`, or by invoking the CLI directly with the same environment file. After validation:

```bash
sudo systemctl enable --now delivery-orchestrator-branch-hygiene.timer
```

The service uses `flock` and the CLI also holds an atomic lock file, so concurrent scheduled/manual runs fail without mutation.

## Logs and operational rollback

Inspect the service and JSON audits:

```bash
journalctl -u delivery-orchestrator-branch-hygiene.service
ls -1 /var/log/delivery-orchestrator/branch-hygiene
```

Operational rollback means disabling the timer and returning to dry-run:

```bash
sudo systemctl disable --now delivery-orchestrator-branch-hygiene.timer
```

A deleted Git ref is not recreated automatically. If a branch must be restored, recreate it explicitly from the SHA recorded in the JSON audit after confirming that SHA is the intended target. Keep the former Skill/web schedule disabled to avoid two hygiene mechanisms competing for the same refs.
