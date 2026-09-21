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
    const loginHome = join(dir, 'login-home');
    const manifest = join(dir, 'safeoutputs.jsonl');

    await mkdir(mcpBin, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(loginHome, { recursive: true });

    // Simula o profile de um login shell sobrescrevendo o PATH curado
    // pelo AWF. Com allow_login_shell=false este arquivo nao deve ser lido
    // pelos comandos executados pelo Codex.
    await writeFile(
      join(loginHome, '.bash_profile'),
      'export PATH=/definitely-missing\n'
    );

    const safeoutputs = join(mcpBin, 'safeoutputs');
    const codex = join(fakeBin, 'codex');
    const pnpm = join(fakeBin, 'pnpm');

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
    if [ "\${2:-}" = "--help" ]; then
      echo "mock safeoutputs noop"
      exit 0
    fi
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

# Simula a politica interna do Codex removendo BASH_ENV antes de executar
# comandos. Sem allow_login_shell=false, bash -lc carrega .bash_profile,
# substitui PATH e perde toolcache/safeoutputs.
shell_mode="-lc"
previous=""
for arg in "$@"; do
  if [ "$previous" = "-c" ] && [ "$arg" = "allow_login_shell=false" ]; then
    shell_mode="-c"
  fi
  previous="$arg"
done

test "$shell_mode" = "-c"
unset BASH_ENV
export HOME="\${DELIVERY_V2_TEST_LOGIN_HOME:?}"

/bin/bash "$shell_mode" 'git --version >/dev/null; node --version >/dev/null; npm --version >/dev/null; pnpm --version >/dev/null; safeoutputs noop'
`
    );

    await writeFile(
      pnpm,
      `#!/usr/bin/env bash
set -euo pipefail
echo "9.0.0"
`
    );

    await chmod(safeoutputs, 0o755);
    await chmod(codex, 0o755);
    await chmod(pnpm, 0o755);

    const shellProbe =
      'git --version >/dev/null && ' +
      'node --version >/dev/null && ' +
      'npm --version >/dev/null && ' +
      'pnpm --version >/dev/null && ' +
      'safeoutputs noop --help >/dev/null';

    const shellProbeEnv = {
      ...process.env,
      HOME: loginHome,
      RUNNER_TEMP: runTemp,
      GH_AW_SAFE_OUTPUTS: manifest,
      PATH: `${fakeBin}:${mcpBin}:/usr/local/bin:/usr/bin:/bin`
    };

    // Controle negativo discriminante: o login shell carrega
    // .bash_profile, substitui o PATH e deve perder o toolchain.
    const loginShell = spawnSync('/bin/bash', ['-lc', shellProbe], {
      encoding: 'utf8',
      env: shellProbeEnv
    });

    assert.notEqual(
      loginShell.status,
      0,
      `login shell deveria perder o PATH curado
stdout:
${loginShell.stdout}
stderr:
${loginShell.stderr}`
    );

    // Caso corrigido: o non-login shell deve preservar exatamente
    // o PATH herdado do worker/AWF.
    const nonLoginShell = spawnSync('/bin/bash', ['-c', shellProbe], {
      encoding: 'utf8',
      env: shellProbeEnv
    });

    assert.equal(
      nonLoginShell.status,
      0,
      `non-login shell deveria preservar o PATH curado
stdout:
${nonLoginShell.stdout}
stderr:
${nonLoginShell.stderr}`
    );

    const result = spawnSync(wrapper, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: runTemp,
        GH_AW_SAFE_OUTPUTS: manifest,
        DELIVERY_V2_TEST_LOGIN_HOME: loginHome,
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
      /Delivery V2 Codex child-shell toolchain preflight: PASS/
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
