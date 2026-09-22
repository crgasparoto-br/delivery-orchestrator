#!/usr/bin/env node
// Registers the host git executable into RUNNER_TOOL_CACHE using the same
// toolcache bin-directory convention the Delivery V2 agent sandbox (awf)
// scans to build PATH inside the isolated Codex worker container, then
// verifies that git, node, npm and pnpm all resolve through that exact mechanism
// before the "Execute Codex CLI" step (and its AI budget) runs.
//
// Root cause (issue #151, regression on #108 / PR #112): installing git on
// the GitHub Actions host only makes it available at a system path such as
// /usr/bin/git. The awf sandbox mounts that path read-only but does not add
// it to the PATH it constructs inside the container. Only directories
// discovered under RUNNER_TOOL_CACHE via
//   find "$RUNNER_TOOL_CACHE" -maxdepth 5 -type d -name bin
// are added to PATH inside the sandbox -- the same mechanism `runtimes:
// node` already relies on via actions/setup-node. This script extends that
// already-trusted mechanism to git and fails the job before Codex runs if
// any required tool would still be invisible inside the sandbox.

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  readlinkSync,
  lstatSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
  chmodSync
} from 'node:fs';
import { dirname, join } from 'node:path';

const REQUIRED_TOOLS = ['git', 'node', 'npm', 'pnpm'];
const MAX_SCAN_DEPTH = 5;

function fail(message) {
  throw new Error(message);
}

function commandPath(tool) {
  try {
    return execSync(`command -v ${tool}`, { shell: '/bin/bash', encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function resolveToolCache(env = process.env) {
  const toolCache = env.RUNNER_TOOL_CACHE;
  if (!toolCache) {
    fail(
      'RUNNER_TOOL_CACHE must be set. The Delivery V2 sandbox toolchain contract relies on this GitHub Actions runner variable to publish tools into the read-only mount the agent sandbox (awf) exposes to the Codex worker.'
    );
  }
  return toolCache;
}

export function registerGit(toolCache, { gitPath = commandPath('git') } = {}) {
  if (!gitPath) {
    fail('git is not installed on the runner host. Install it before registering it into the sandbox toolcache.');
  }
  const realGitPath = realpathSync(gitPath);
  const version = execSync(`"${realGitPath}" --version`, { encoding: 'utf8' })
    .trim()
    .replace(/^git version /, '');
  const binDir = join(toolCache, 'git', version, 'x64', 'bin');
  mkdirSync(binDir, { recursive: true });
  const linkPath = join(binDir, 'git');
  if (isSymlink(linkPath)) {
    if (readlinkSync(linkPath) === realGitPath) {
      return { binDir, version, linkPath };
    }
    rmSync(linkPath, { force: true });
  } else if (existsSync(linkPath)) {
    rmSync(linkPath, { force: true });
  }
  symlinkSync(realGitPath, linkPath);
  return { binDir, version, linkPath };
}

export function findBinDirs(root, maxDepth = MAX_SCAN_DEPTH) {
  const results = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === 'bin') results.push(full);
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return results;
}

export function resolveInBinDirs(tool, binDirs) {
  for (const dir of binDirs) {
    const candidate = join(dir, tool);
    try {
      const st = statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // not present in this bin dir
    }
  }
  return '';
}


const CODEX_COMMAND_TOOLS = Object.freeze([
  'bash',
  'cat',
  'git',
  'sed',
  'node',
  'npm',
  'pnpm'
]);

function shellDoubleQuote(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`');
}

export function findNamedDirectory(root, name, maxDepth = 8) {
  const walk = (dir, depth) => {
    if (depth > maxDepth) return '';

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return '';
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.name === name) {
        try {
          if (statSync(full).isDirectory()) return full;
        } catch {
          // Continue bounded search.
        }
      }

      if (!entry.isDirectory()) continue;

      const nested = walk(full, depth + 1);
      if (nested) return nested;
    }

    return '';
  };

  return walk(root, 0);
}

export function resolveCodexCommandPath({
  codexPath = commandPath('codex')
} = {}) {
  if (!codexPath) {
    fail(
      'codex is not installed on the runner host; cannot stage the restricted command toolchain before AWF starts.'
    );
  }

  const realCodexPath = realpathSync(codexPath);
  const codexRoot = realpathSync(join(dirname(realCodexPath), '..'));
  const commandPathDir = findNamedDirectory(
    codexRoot,
    'codex-path'
  );

  if (!commandPathDir) {
    fail(
      `Codex restricted codex-path was not found below ${codexRoot}.`
    );
  }

  return commandPathDir;
}

export function publishCodexCommandShim(
  commandPathDir,
  tool,
  target
) {
  if (!commandPathDir || !existsSync(commandPathDir)) {
    fail(
      `Codex restricted command directory is missing: ${commandPathDir}`
    );
  }

  if (!statSync(commandPathDir).isDirectory()) {
    fail(
      `Codex restricted command path is not a directory: ${commandPathDir}`
    );
  }

  if (!target || !String(target).startsWith('/')) {
    fail(
      `Cannot stage ${tool}: expected an absolute executable target, got ${target || '<empty>'}`
    );
  }

  const shimPath = join(commandPathDir, tool);
  const escapedTarget = shellDoubleQuote(target);

  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec "${escapedTarget}" "$@"\n`,
    { mode: 0o755 }
  );
  chmodSync(shimPath, 0o755);

  return shimPath;
}

export function stageCodexCommandToolchain({
  toolCache = resolveToolCache(),
  env = process.env,
  commandPathDir
} = {}) {
  const binDirs = findBinDirs(toolCache);
  const codexCommandPath =
    commandPathDir || resolveCodexCommandPath();

  const targets = {};

  for (const tool of CODEX_COMMAND_TOOLS) {
    let target = '';

    if (['git', 'node', 'npm', 'pnpm'].includes(tool)) {
      target = resolveInBinDirs(tool, binDirs);
    }

    if (!target) {
      target = commandPath(tool);
    }

    if (!target) {
      fail(
        `Cannot stage ${tool} into Codex restricted command PATH before AWF starts.`
      );
    }

    targets[tool] = target;

    publishCodexCommandShim(
      codexCommandPath,
      tool,
      target
    );
  }

  if (!env.RUNNER_TEMP) {
    fail(
      'RUNNER_TEMP must be set to stage the future safeoutputs command shim.'
    );
  }

  // safeoutputs is materialized later by gh-aw, after this host-side
  // preprocessing step and before the Codex engine executes. Stage a
  // deterministic wrapper to that future path now, while /usr/local is
  // still writable on the runner host.
  const safeoutputsTarget = join(
    env.RUNNER_TEMP,
    'gh-aw',
    'mcp-cli',
    'bin',
    'safeoutputs'
  );

  targets.safeoutputs = safeoutputsTarget;

  publishCodexCommandShim(
    codexCommandPath,
    'safeoutputs',
    safeoutputsTarget
  );

  return Object.freeze({
    commandPath: codexCommandPath,
    targets: Object.freeze({ ...targets })
  });
}

function main() {
  const toolCache = resolveToolCache();
  const { binDir, version } = registerGit(toolCache);
  console.log(`Registered git ${version} into sandbox toolcache: ${binDir}`);

  const binDirs = findBinDirs(toolCache);
  const missing = [];
  for (const tool of REQUIRED_TOOLS) {
    const resolved = resolveInBinDirs(tool, binDirs);
    if (!resolved) {
      missing.push(tool);
      continue;
    }
    console.log(`sandbox-toolchain: ${tool} -> ${resolved}`);
  }

  if (missing.length > 0) {
    fail(
      `Delivery V2 sandbox toolchain preflight failed: ${missing.join(', ')} not discoverable under RUNNER_TOOL_CACHE (${toolCache}) via the same bin-directory scan the agent sandbox uses to build PATH. ` +
        'Declare the missing tool under `runtimes:` in the worker workflow (for node/npm) or extend this script (for other host tools) before the Codex CLI step runs, so the failure is caught before AI budget is spent.'
    );
  }

  const staged = stageCodexCommandToolchain({ toolCache });

  console.log(
    `Staged Codex restricted command toolchain on runner host: ${staged.commandPath}`
  );

  for (const [tool, target] of Object.entries(staged.targets)) {
    console.log(`codex-command-toolchain: ${tool} -> ${target}`);
  }

  console.log(
    'Delivery V2 sandbox toolchain preflight passed: git, node, npm and pnpm all resolve via the RUNNER_TOOL_CACHE bin-directory scan used inside the agent sandbox.'
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
