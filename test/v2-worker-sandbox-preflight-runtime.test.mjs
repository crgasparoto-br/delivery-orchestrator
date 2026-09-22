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

test('effective sandbox propagates BASH_ENV to explicit Codex login-shell commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'delivery-v2-preflight-'));

  try {
    const runTemp = join(dir, 'runner-temp');
    const mcpBin = join(runTemp, 'gh-aw', 'mcp-cli', 'bin');
    const fakeBin = join(dir, 'bin');
    const codexCommandPath = join(
      dir,
      'codex-runtime',
      'vendor',
      'codex-path'
    );
    const loginHome = join(dir, 'login-home');
    const manifest = join(dir, 'safeoutputs.jsonl');

    await mkdir(mcpBin, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(codexCommandPath, { recursive: true });
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

# Simula a reconstrucao do ambiente aplicada pelo Codex aos command tools.
# Mesmo com allow_login_shell=false, o modelo ainda pode invocar
# explicitamente /bin/bash -lc. Nesse caso BASH_ENV precisa restaurar a
# toolchain depois que o login profile substituir PATH.
allow_non_login=false
policy_path=""
policy_bash_env=""
previous=""

for arg in "$@"; do
  if [ "$previous" = "-c" ]; then
    case "$arg" in
      allow_login_shell=false)
        allow_non_login=true
        ;;
      shell_environment_policy.set.PATH=*)
        policy_path=\${arg#shell_environment_policy.set.PATH=}
        ;;
      shell_environment_policy.set.BASH_ENV=*)
        policy_bash_env=\${arg#shell_environment_policy.set.BASH_ENV=}
        ;;
    esac
  fi
  previous="$arg"
done

test "$allow_non_login" = "true"
test -n "$policy_path"
test -n "$policy_bash_env"

# Os valores de shell_environment_policy chegam delimitados por aspas.
policy_path=\${policy_path#\\\"}
policy_path=\${policy_path%\\\"}
policy_bash_env=\${policy_bash_env#\\\"}
policy_bash_env=\${policy_bash_env%\\\"}

# Reproduz o comportamento observado no worker real: o command subprocess
# ignora o PATH amplo do host e recebe somente o codex-path interno. Os shims
# publicados pelo wrapper devem manter a toolchain disponivel mesmo assim.
restricted_path="\${DELIVERY_V2_TEST_CODEX_COMMAND_PATH:?}"

env -i \
  PATH="$restricted_path" \
  /bin/bash -c 'git --version >/dev/null; node --version >/dev/null; npm --version >/dev/null; pnpm --version >/dev/null; safeoutputs noop --help >/dev/null'

# Reconstroi um ambiente minimo, como o command environment do Codex.
# O .bash_profile abaixo destrói PATH; BASH_ENV deve restaura-lo dentro
# do bash -lc explicito.
env -i HOME="\${DELIVERY_V2_TEST_LOGIN_HOME:?}" GH_AW_SAFE_OUTPUTS="\${GH_AW_SAFE_OUTPUTS:?}" PATH="$policy_path" BASH_ENV="$policy_bash_env" /bin/bash -lc 'git --version >/dev/null; node --version >/dev/null; npm --version >/dev/null; pnpm --version >/dev/null; safeoutputs noop'
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
        DELIVERY_V2_TEST_CODEX_COMMAND_PATH: codexCommandPath,
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

    assert.match(
      result.stdout,
      /Delivery V2 Codex restricted command PATH toolchain: PASS/
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
