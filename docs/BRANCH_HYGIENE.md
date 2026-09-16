# Branch hygiene on the VPS

Branch hygiene is deterministic and runs without ChatGPT, Skills, or an LLM. The functional scope comes only from `ORCHESTRATOR_REPOSITORIES`; the GitHub token only grants access to that configured scope.

## Configuration

Create `/etc/delivery-orchestrator/hygiene.env` from `deploy/systemd/hygiene.env.example` and set the managed repositories plus a Fine-grained PAT:

```bash
ORCHESTRATOR_REPOSITORIES=owner/repository-a,owner/repository-b
GITHUB_TOKEN=<fine-grained-token>
ORCHESTRATOR_HYGIENE_LOG_DIR=/var/log/delivery-orchestrator/branch-hygiene
```

An empty or invalid `ORCHESTRATOR_REPOSITORIES` aborts before mutation. Repositories are never discovered from token visibility. For a Fine-grained PAT, grant repository **Contents: read and write** to each configured repository and the read permissions needed for metadata, pull requests, checks/actions, rules and commit comparison. Do not grant administration merely for this routine.

## Versioned runtime promotion

The VPS keeps the Git source checkout at `/opt/delivery-orchestrator`, the mutable runtime root at `/opt/delivery-orchestrator-runtime`, immutable validated releases under `/opt/delivery-orchestrator-runtime/releases/<sha>`, and the active runtime pointer at `/opt/delivery-orchestrator-runtime/current`.

Before every scheduled hygiene run, `scripts/vps-release-hygiene.mjs`:

1. acquires the global operation lock;
2. verifies the source checkout and active release are clean;
3. fetches only `origin/main`;
4. proves the active SHA is an ancestor of the remote candidate;
5. materializes the candidate in a separate Git worktree;
6. requires Node >= 22, `npm ci`, `npm test`, `npm run verify:v2`, exact candidate SHA and a clean worktree;
7. stores an exact-SHA validation marker;
8. atomically switches `/opt/delivery-orchestrator-runtime/current` to the validated release;
9. revalidates the active SHA;
10. runs branch hygiene from that exact release;
11. retains the active release plus the newest validated rollback releases, controlled by `ORCHESTRATOR_RELEASE_RETENTION` (default 3).

A failed fetch, dirty state, divergence, install/test/verify failure or inconclusive promotion preserves the previous active release and skips hygiene. There is no automatic merge, rebase or `git reset --hard` recovery.

Release update audits are written to `/var/log/delivery-orchestrator/release-update`. Branch hygiene audits remain under `/var/log/delivery-orchestrator/branch-hygiene`.

## Migrating an existing issue #92 installation

After the implementation is present in the source checkout, run the idempotent installer once:

```bash
cd /opt/delivery-orchestrator
git fetch origin
git checkout main
git pull --ff-only origin main
sudo ./scripts/install-vps-release-layout.sh
```

The installer preserves `/etc/delivery-orchestrator/hygiene.env`, appends only missing release-runtime settings, bootstraps and validates the first versioned release, installs the versioned `systemd` units, reloads `systemd` and enables the existing timer.

Validate the migration:

```bash
readlink -f /opt/delivery-orchestrator-runtime/current
git -C /opt/delivery-orchestrator-runtime/current rev-parse HEAD
sudo systemctl status delivery-orchestrator-branch-hygiene.timer --no-pager -l
```

## Manual commands

Update and validate the runtime without running hygiene:

```bash
sudo bash -c 'set -a; source /etc/delivery-orchestrator/hygiene.env; set +a; /usr/bin/flock -n /run/lock/delivery-orchestrator-release-hygiene.lock /usr/bin/node /opt/delivery-orchestrator-runtime/current/scripts/vps-release-hygiene.mjs --update-only'
```

Run the complete update + hygiene flow exactly as the timer does:

```bash
sudo systemctl start delivery-orchestrator-branch-hygiene.service
sudo systemctl status delivery-orchestrator-branch-hygiene.service --no-pager -l
```

The low-level hygiene CLI remains available for diagnostics. Its default is non-destructive:

```bash
node src/cli.mjs hygiene --older-than 7d --dry-run
```

Apply only after validating dry-run output:

```bash
node src/cli.mjs hygiene --older-than 7d --apply
```

A branch can be removed only when it is older than the threshold, is not the default branch, `main` or `develop`, is not protected by branch protection/rulesets, has no open PR, has no non-terminal workflow/check, and has no unique commit compared with the applicable base (`develop` when present, otherwise the default branch). Any uncertain gate preserves the branch. In `--apply`, repository state, branch SHA and all safety gates are re-read immediately before deletion.

## systemd scheduling

Install or refresh the versioned units with the installer above. The timer runs daily and the service wraps the complete release promotion + hygiene cycle in `flock`. The runtime also owns a second atomic process lock so a concurrent manual invocation exits without mutation.

`ProtectSystem=strict` remains enabled. Write access is limited to the source checkout (for `fetch`/worktree metadata), `/opt/delivery-orchestrator-runtime`, audit/validation directories and lock files; the service does not need blanket write access to `/opt`.

Inspect scheduling and logs:

```bash
systemctl list-timers --all | grep delivery-orchestrator
sudo journalctl -u delivery-orchestrator-branch-hygiene.service -n 100 --no-pager
sudo ls -lht /var/log/delivery-orchestrator/release-update | head
sudo ls -lht /var/log/delivery-orchestrator/branch-hygiene | head
```

## Failure handling and rollback

Disable future runs first if operational intervention is required:

```bash
sudo systemctl disable --now delivery-orchestrator-branch-hygiene.timer
```

A failed candidate before promotion leaves the previous release active. If a previously validated release must be restored manually, choose a retained SHA only after checking its validation marker/audit, then atomically repoint the active symlink and verify it before re-enabling the timer. Do not use `git reset --hard` as rollback.

Example explicit rollback:

```bash
SHA=<validated-retained-sha>
sudo ln -sfn "/opt/delivery-orchestrator-runtime/releases/$SHA" /opt/delivery-orchestrator-runtime/current.next
sudo mv -Tf /opt/delivery-orchestrator-runtime/current.next /opt/delivery-orchestrator-runtime/current
git -C /opt/delivery-orchestrator-runtime/current rev-parse HEAD
```

A deleted Git branch is not recreated automatically. If a branch must be restored, recreate it explicitly from the SHA recorded in the branch hygiene JSON audit. Keep any former Skill/web hygiene schedule disabled so two mechanisms do not compete for the same refs.
