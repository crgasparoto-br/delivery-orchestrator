import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper =
  '.github/scripts/run-delivery-v2-codex-with-sandbox-preflight.sh';

test('effective sandbox exposes safeoutputs to the Codex child process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'delivery-v2-preflight-'));

  try {
    const runTemp = join(dir, 'runner-temp');
    const mcpBin = join(runTemp, 'gh-aw', 'mcp-cli', 'bin');
    const fakeBin = join(dir, 'bin');
    const manifest = join(dir, 'safeoutputs.jsonl');

    await mkdir(mcpBin, { recursive: true });
    await mkdir(fakeBin, { recursive: true });

    const safeoutputs = join(mcpBin, 'safeoutputs');
    const codex = join(fakeBin, 'codex');

    await writeFile(
      safeoutputs,
      `#!/usr/bin/env bash
set -euo pipefail

case "\${1:-}" in
  create_pull_request|push_to_pull_request_branch)
    if [ "\${2:-}" = "--help" ]; then
      echo "mock safeoutputs \$1"
      exit 0
    fi
    ;;
  noop)
    printf '{"tool":"noop"}\\n' >> "\${GH_AW_SAFE_OUTPUTS:?}"
    exit 0
    ;;
esac

exit 2
`
    );

    await writeFile(
      codex,
      `#!/usr/bin/env bash
set -euo pipefail
safeoutputs noop
`
    );

    await chmod(safeoutputs, 0o755);
    await chmod(codex, 0o755);

    const result = spawnSync(wrapper, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: runTemp,
        GH_AW_SAFE_OUTPUTS: manifest,
        PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin`
      }
    });

    assert.equal(
      result.status,
      0,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );

    assert.match(
      result.stdout,
      /Delivery V2 effective sandbox toolchain preflight: PASS/
    );

    const emitted = await readFile(manifest, 'utf8');
    assert.equal(emitted, '{"tool":"noop"}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const risk of ['fast', 'standard', 'critical']) {
  test(`${risk} compiled worker routes Codex through effective sandbox wrapper`, async () => {
    const lock = await readFile(
      `.github/workflows/delivery-v2-worker-codex-${risk}.lock.yml`,
      'utf8'
    );

    assert.match(lock, /codex_harness\.cjs/);
    assert.match(
      lock,
      /run-delivery-v2-codex-with-sandbox-preflight\.sh/
    );
    assert.match(lock, /mcp-cli\/bin/);
    assert.match(lock, /GH_AW_SAFE_OUTPUTS/);
    assert.match(lock, /RUNNER_TOOL_CACHE/);
  });
}
