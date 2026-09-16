import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const RELEASE_GATES_VERSION = 'node>=22+npm-ci+npm-test+verify-v2:v1';

export function sanitize(value, secrets = [process.env.GITHUB_TOKEN]) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(authorization\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]');
}

export function nodeMajor(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10);
}

export function isSupportedNode(version = process.versions.node) {
  return Number.isInteger(nodeMajor(version)) && nodeMajor(version) >= 22;
}

export function decideUpdate({ currentSha, candidateSha, sourceClean, currentClean, ancestor }) {
  if (!sourceClean) return { action: 'blocked', reason: 'source-working-tree-dirty' };
  if (currentSha && !currentClean) return { action: 'blocked', reason: 'active-release-dirty' };
  if (!candidateSha) return { action: 'failed', reason: 'candidate-sha-unresolved' };
  if (!currentSha) return { action: 'promote', reason: 'bootstrap' };
  if (candidateSha === currentSha) return { action: 'already-current', reason: 'already-current' };
  if (!ancestor) return { action: 'blocked', reason: 'non-fast-forward-divergence' };
  return { action: 'promote', reason: 'fast-forward-candidate' };
}

export async function runReleaseCycle({ ops, runHygiene = true, bootstrap = false, origin = 'timer' }) {
  const audit = {
    timestamp: new Date().toISOString(), origin, current_sha: null, candidate_sha: null,
    ancestry: null, gates: {}, decision: 'failed', reason: null, executed_sha: null,
    active_release: null, error: null,
  };
  let locked = false;
  let promoted = false;
  try {
    ops.acquireLock();
    locked = true;
    const sourceClean = ops.sourceClean();
    audit.gates.source_clean = sourceClean;
    const currentSha = ops.currentSha();
    audit.current_sha = currentSha;
    if (!currentSha && !bootstrap) {
      audit.decision = 'blocked'; audit.reason = 'current-release-missing'; return audit;
    }
    const currentClean = currentSha ? ops.currentClean() : true;
    audit.gates.current_clean = currentClean;
    if (!sourceClean || !currentClean) {
      const decision = decideUpdate({ currentSha, candidateSha: 'pending', sourceClean, currentClean, ancestor: false });
      audit.decision = decision.action; audit.reason = decision.reason; return audit;
    }

    let candidateSha;
    try {
      candidateSha = ops.fetchCandidateSha();
    } catch (error) {
      audit.decision = 'failed'; audit.reason = 'fetch-failed'; audit.error = sanitize(error?.message ?? error); return audit;
    }
    audit.candidate_sha = candidateSha;
    let ancestor = true;
    if (currentSha && candidateSha !== currentSha) ancestor = ops.isAncestor(currentSha, candidateSha);
    audit.ancestry = currentSha ? ancestor : null;
    const decision = decideUpdate({ currentSha, candidateSha, sourceClean, currentClean, ancestor });
    audit.decision = decision.action;
    audit.reason = decision.reason;
    if (decision.action === 'blocked' || decision.action === 'failed') return audit;

    let executionSha = currentSha;
    if (decision.action === 'promote') {
      const gateResults = ops.prepareCandidate(candidateSha);
      audit.gates = { ...audit.gates, ...gateResults };
      if (Object.values(gateResults).some((value) => value !== true && value !== 'reused')) {
        audit.decision = 'failed'; audit.reason = 'candidate-validation-failed'; return audit;
      }
      ops.promote(candidateSha);
      promoted = true;
      const activeSha = ops.currentSha();
      if (activeSha !== candidateSha) {
        audit.decision = 'failed'; audit.reason = 'promotion-verification-failed'; return audit;
      }
      executionSha = candidateSha;
      audit.decision = 'promoted'; audit.reason = 'validated-and-promoted';
    }

    audit.active_release = ops.activeRelease();
    if (runHygiene) {
      audit.executed_sha = executionSha;
      const hygieneStatus = ops.runHygiene(executionSha);
      audit.gates.hygiene = hygieneStatus === 0;
      if (hygieneStatus !== 0) {
        audit.decision = promoted ? 'promoted-hygiene-failed' : 'hygiene-failed';
        audit.reason = 'hygiene-command-failed';
        return audit;
      }
      ops.pruneReleases(executionSha);
    }
    return audit;
  } catch (error) {
    audit.error = sanitize(error?.message ?? error);
    if (!audit.reason) audit.reason = promoted ? 'promoted-but-hygiene-not-run' : 'unexpected-error';
    audit.decision = 'failed';
    return audit;
  } finally {
    try { audit.active_release = ops.activeRelease(); } catch {}
    try { ops.writeAudit(audit); } catch {}
    if (locked) ops.releaseLock();
  }
}

function command(command, args, { cwd, env = process.env, allow = [0] } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (!allow.includes(result.status)) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${sanitize(result.stderr || result.stdout)}`);
  }
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function atomicSymlink(target, linkPath) {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  const temporary = `${linkPath}.next-${process.pid}`;
  try { unlinkSync(temporary); } catch {}
  symlinkSync(target, temporary, 'dir');
  renameSync(temporary, linkPath);
}

export function createSystemOps(config = {}) {
  const sourceRepo = config.sourceRepo || process.env.ORCHESTRATOR_SOURCE_REPO || '/opt/delivery-orchestrator';
  const releasesDir = config.releasesDir || process.env.ORCHESTRATOR_RELEASES_DIR || '/opt/delivery-orchestrator-releases';
  const currentLink = config.currentLink || process.env.ORCHESTRATOR_CURRENT_LINK || '/opt/delivery-orchestrator-current';
  const logDir = config.logDir || process.env.ORCHESTRATOR_RELEASE_LOG_DIR || '/var/log/delivery-orchestrator/release-update';
  const validationDir = config.validationDir || process.env.ORCHESTRATOR_RELEASE_VALIDATION_DIR || '/var/lib/delivery-orchestrator/release-validation';
  const lockFile = config.lockFile || process.env.ORCHESTRATOR_RELEASE_LOCK_FILE || '/run/lock/delivery-orchestrator-release-hygiene-process.lock';
  const retention = Math.max(2, Number(config.retention || process.env.ORCHESTRATOR_RELEASE_RETENTION || 3));
  let lockFd = null;
  mkdirSync(releasesDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(validationDir, { recursive: true });
  mkdirSync(path.dirname(lockFile), { recursive: true });

  const git = (args, cwd = sourceRepo, options = {}) => command('git', args, { cwd, ...options });
  const markerPath = (sha) => path.join(validationDir, `${sha}.json`);
  const releasePath = (sha) => path.join(releasesDir, sha);

  return {
    acquireLock() {
      try { lockFd = openSync(lockFile, 'wx', 0o600); }
      catch (error) { throw new Error(`lock-held: ${error.code || 'unknown'}`); }
    },
    releaseLock() {
      if (lockFd !== null) closeSync(lockFd);
      lockFd = null;
      try { unlinkSync(lockFile); } catch {}
    },
    sourceClean() { return git(['status', '--porcelain']).stdout === ''; },
    currentSha() {
      if (!existsSync(currentLink)) return null;
      return git(['rev-parse', 'HEAD'], currentLink).stdout;
    },
    currentClean() { return git(['status', '--porcelain'], currentLink).stdout === ''; },
    fetchCandidateSha() {
      git(['fetch', '--no-tags', 'origin', 'main']);
      return git(['rev-parse', 'FETCH_HEAD']).stdout;
    },
    isAncestor(currentSha, candidateSha) {
      const result = git(['merge-base', '--is-ancestor', currentSha, candidateSha], sourceRepo, { allow: [0, 1] });
      return result.status === 0;
    },
    prepareCandidate(candidateSha) {
      if (!isSupportedNode()) throw new Error(`unsupported-node-${process.versions.node}`);
      const finalPath = releasePath(candidateSha);
      const marker = markerPath(candidateSha);
      if (existsSync(finalPath) && existsSync(marker)) {
        const parsed = JSON.parse(readFileSync(marker, 'utf8'));
        const exact = git(['rev-parse', 'HEAD'], finalPath).stdout === candidateSha;
        const clean = git(['status', '--porcelain'], finalPath).stdout === '';
        if (parsed.sha === candidateSha && parsed.gates_version === RELEASE_GATES_VERSION && exact && clean) {
          return { node: true, npm_ci: 'reused', npm_test: 'reused', verify_v2: 'reused', exact_sha: true, clean: true };
        }
        throw new Error('existing-release-failed-validation-marker');
      }
      if (existsSync(finalPath)) throw new Error('existing-release-without-validation-marker');
      const staging = path.join(releasesDir, `.staging-${candidateSha}-${process.pid}`);
      if (existsSync(staging)) throw new Error('staging-path-already-exists');
      git(['worktree', 'add', '--detach', staging, candidateSha]);
      let moved = false;
      try {
        command('npm', ['ci'], { cwd: staging });
        command('npm', ['test'], { cwd: staging });
        command('npm', ['run', 'verify:v2'], { cwd: staging });
        const exact = git(['rev-parse', 'HEAD'], staging).stdout === candidateSha;
        const clean = git(['status', '--porcelain'], staging).stdout === '';
        if (!exact || !clean) throw new Error('candidate-identity-or-cleanliness-failed');
        git(['worktree', 'move', staging, finalPath]);
        moved = true;
        writeFileSync(marker, `${JSON.stringify({ sha: candidateSha, gates_version: RELEASE_GATES_VERSION, validated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
        return { node: true, npm_ci: true, npm_test: true, verify_v2: true, exact_sha: true, clean: true };
      } finally {
        if (!moved && existsSync(staging)) {
          try { git(['worktree', 'remove', '--force', staging]); } catch {}
        }
      }
    },
    promote(candidateSha) { atomicSymlink(releasePath(candidateSha), currentLink); },
    activeRelease() {
      if (!existsSync(currentLink)) return null;
      try { return path.resolve(path.dirname(currentLink), readlinkSync(currentLink)); }
      catch { return path.resolve(currentLink); }
    },
    runHygiene(expectedSha) {
      const activeSha = git(['rev-parse', 'HEAD'], currentLink).stdout;
      if (activeSha !== expectedSha) throw new Error('executed-sha-mismatch');
      return command(process.execPath, ['src/cli.mjs', 'hygiene', '--older-than', '7d', '--apply', '--lock-file', '/run/lock/delivery-orchestrator-branch-hygiene-process.lock'], { cwd: currentLink, allow: [0, 1] }).status;
    },
    pruneReleases(activeSha) {
      const candidates = readdirSync(releasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[0-9a-f]{40}$/.test(entry.name))
        .map((entry) => ({ sha: entry.name, mtime: statSync(path.join(releasesDir, entry.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const keep = new Set([activeSha, ...candidates.filter((entry) => entry.sha !== activeSha).slice(0, retention - 1).map((entry) => entry.sha)]);
      for (const entry of candidates) {
        if (keep.has(entry.sha)) continue;
        try { git(['worktree', 'remove', '--force', releasePath(entry.sha)]); } catch { continue; }
        try { unlinkSync(markerPath(entry.sha)); } catch {}
      }
    },
    writeAudit(audit) {
      const stamp = audit.timestamp.replace(/[:.]/g, '-');
      writeFileSync(path.join(logDir, `release-update-${stamp}.json`), `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o640 });
    },
  };
}
