import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import {
  resolveToolCache,
  registerGit,
  findBinDirs,
  resolveInBinDirs,
  publishCodexCommandShim
} from '../.github/scripts/ensure-delivery-v2-worker-sandbox-toolchain.mjs';

function makeFakeExecutable(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho fake\n');
  chmodSync(path, 0o755);
}

test('Codex command shim is staged before the command directory becomes read-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-v2-codex-command-'));
  const commandPath = join(root, 'codex-path');
  const target = join(root, 'real-tool');
  const shim = join(commandPath, 'tool');

  mkdirSync(commandPath, { recursive: true });
  makeFakeExecutable(target);

  try {
    publishCodexCommandShim(commandPath, 'tool', target);

    chmodSync(commandPath, 0o555);

    const result = spawnSync(shim, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: commandPath
      }
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'fake');

    chmodSync(commandPath, 0o755);
  } finally {
    try {
      chmodSync(commandPath, 0o755);
    } catch {
      // Directory may already be gone after an earlier assertion failure.
    }

    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveToolCache requires RUNNER_TOOL_CACHE', () => {
  assert.throws(() => resolveToolCache({}), /RUNNER_TOOL_CACHE/);
});

test('resolveToolCache returns the configured value', () => {
  assert.equal(resolveToolCache({ RUNNER_TOOL_CACHE: '/opt/hostedtoolcache' }), '/opt/hostedtoolcache');
});

test('registerGit publishes a discoverable bin directory using the toolcache convention', () => {
  const toolCache = mkdtempSync(join(tmpdir(), 'delivery-v2-toolcache-'));
  const fakeGitDir = mkdtempSync(join(tmpdir(), 'delivery-v2-realgit-'));
  const fakeGitPath = join(fakeGitDir, 'git');
  makeFakeExecutable(fakeGitPath);

  try {
    const { binDir, linkPath } = registerGit(toolCache, { gitPath: fakeGitPath });
    assert.match(binDir, new RegExp(`^${toolCache}`));
    assert.equal(linkPath, join(binDir, 'git'));

    const binDirs = findBinDirs(toolCache);
    assert.ok(binDirs.includes(binDir), 'registered bin dir must be discoverable by the sandbox bin-directory scan');

    const resolved = resolveInBinDirs('git', binDirs);
    assert.equal(resolved, linkPath);
  } finally {
    rmSync(toolCache, { recursive: true, force: true });
    rmSync(fakeGitDir, { recursive: true, force: true });
  }
});

test('registerGit is idempotent when called twice for the same git binary', () => {
  const toolCache = mkdtempSync(join(tmpdir(), 'delivery-v2-toolcache-'));
  const fakeGitDir = mkdtempSync(join(tmpdir(), 'delivery-v2-realgit-'));
  const fakeGitPath = join(fakeGitDir, 'git');
  makeFakeExecutable(fakeGitPath);

  try {
    const first = registerGit(toolCache, { gitPath: fakeGitPath });
    const second = registerGit(toolCache, { gitPath: fakeGitPath });
    assert.equal(first.linkPath, second.linkPath);
    assert.equal(findBinDirs(toolCache).filter((d) => d === first.binDir).length, 1);
  } finally {
    rmSync(toolCache, { recursive: true, force: true });
    rmSync(fakeGitDir, { recursive: true, force: true });
  }
});

test('findBinDirs discovers a node-style setup-node layout used inside the sandbox', () => {
  const toolCache = mkdtempSync(join(tmpdir(), 'delivery-v2-toolcache-'));
  const nodeBinDir = join(toolCache, 'node', '22.0.0', 'x64', 'bin');
  mkdirSync(nodeBinDir, { recursive: true });
  writeFileSync(join(nodeBinDir, 'node'), '');
  writeFileSync(join(nodeBinDir, 'npm'), '');

  try {
    const binDirs = findBinDirs(toolCache);
    assert.ok(binDirs.includes(nodeBinDir));
    assert.equal(resolveInBinDirs('node', binDirs), join(nodeBinDir, 'node'));
    assert.equal(resolveInBinDirs('npm', binDirs), join(nodeBinDir, 'npm'));
    assert.equal(resolveInBinDirs('does-not-exist', binDirs), '');
  } finally {
    rmSync(toolCache, { recursive: true, force: true });
  }
});


test('findBinDirs discovers the dedicated pnpm toolcache layout used by the sandbox', () => {
  const toolCache = mkdtempSync(join(tmpdir(), 'delivery-v2-toolcache-'));
  const pnpmBinDir = join(toolCache, 'pnpm', '9', 'x64', 'bin');
  const pnpmPath = join(pnpmBinDir, 'pnpm');
  makeFakeExecutable(pnpmPath);

  try {
    const binDirs = findBinDirs(toolCache);

    assert.ok(
      binDirs.includes(pnpmBinDir),
      'pnpm prefix bin directory must be discoverable by the sandbox scan'
    );

    assert.equal(
      resolveInBinDirs('pnpm', binDirs),
      pnpmPath
    );
  } finally {
    rmSync(toolCache, { recursive: true, force: true });
  }
});

for (const risk of ['fast', 'standard', 'critical']) {
  test(`codex ${risk} worker declares the sandbox toolchain contract`, async () => {
    const body = await readFile(`.github/workflows/delivery-v2-worker-codex-${risk}.md`, 'utf8');
    assert.match(body, /runtimes:\s*\n\s+node:\s*\n\s+version: "22"/);
    assert.match(body, /name: Install pnpm 9 for Delivery V2 sandbox/);
    assert.match(body, /PNPM_TOOLCACHE_PREFIX=/);
    assert.match(body, /--prefix "\$PNPM_TOOLCACHE_PREFIX" pnpm@9/);
    assert.match(body, /"\$PNPM_TOOLCACHE_PREFIX\/bin\/pnpm" --version/);
    assert.doesNotMatch(body, /if ! command -v pnpm/);
    assert.match(body, /name: Prove Delivery V2 sandbox toolchain before Codex execution/);
    assert.match(body, /node \.delivery-v2-sandbox-toolchain\/\.github\/scripts\/ensure-delivery-v2-worker-sandbox-toolchain\.mjs/);
    const lockBody = await readFile(`.github/workflows/delivery-v2-worker-codex-${risk}.lock.yml`, 'utf8');
    assert.match(lockBody, /Install pnpm 9 for Delivery V2 sandbox/);
    assert.match(lockBody, /Prove Delivery V2 sandbox toolchain before Codex execution/);
    const preflightIndex = lockBody.indexOf('Prove Delivery V2 sandbox toolchain before Codex execution');
    const executeIndex = lockBody.indexOf('name: Execute Codex CLI');
    assert.ok(preflightIndex > -1 && executeIndex > -1 && preflightIndex < executeIndex, 'preflight must run before Codex CLI execution');
  });
}


test('codex command environment receives the validated sandbox PATH', async () => {
  const wrapper = await readFile(
    '.github/scripts/run-delivery-v2-codex-with-sandbox-preflight.sh',
    'utf8'
  );

  assert.match(
    wrapper,
    /CODEX_SHELL_PATH="\$PATH"/
  );

  assert.match(
    wrapper,
    /shell_environment_policy\.set\.PATH/
  );

  assert.match(
    wrapper,
    /safeoutputs/
  );

  assert.match(
    wrapper,
    /resolve_codex_command_path/
  );

  const hostStager = await readFile(
    '.github/scripts/ensure-delivery-v2-worker-sandbox-toolchain.mjs',
    'utf8'
  );

  assert.match(
    hostStager,
    /stageCodexCommandToolchain/
  );

  assert.match(
    hostStager,
    /mcp-cli/
  );

  assert.match(
    hostStager,
    /safeoutputs/
  );

  assert.doesNotMatch(
    wrapper,
    /publish_codex_command_shim/
  );

  assert.doesNotMatch(
    wrapper,
    /restricted command path is not writable/
  );

  assert.match(
    wrapper,
    /codex-path/
  );

  assert.match(
    wrapper,
    /Delivery V2 Codex restricted command PATH toolchain: PASS/
  );

  assert.match(
    wrapper,
    /pnpm/
  );

  const captureIndex = wrapper.indexOf('CODEX_SHELL_PATH="$PATH"');
  const execIndex = wrapper.indexOf('exec codex');

  assert.ok(
    captureIndex >= 0 && execIndex > captureIndex,
    'validated PATH must be captured before Codex starts'
  );
});
