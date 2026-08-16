import { spawn } from 'node:child_process';

export function runCommand(command, args, { cwd, env = process.env, input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const result = { code, stdout, stderr };
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr || stdout}`));
      } else {
        resolve(result);
      }
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}
