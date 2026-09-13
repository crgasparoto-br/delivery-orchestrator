#!/usr/bin/env node
import { readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const parts = [
  'scripts/.v2-final-part-00',
  'scripts/.v2-final-part-01',
  'scripts/.v2-final-part-02',
  'scripts/.v2-final-part-03'
];
const temp = `${process.env.RUNNER_TEMP || '/tmp'}/apply-v2-final-audit-remediation.mjs`;
try {
  const source = (await Promise.all(parts.map((path) => readFile(path, 'utf8')))).join('');
  await writeFile(temp, source, 'utf8');
  const result = spawnSync(process.execPath, [temp], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await Promise.all(parts.map((path) => rm(path, { force: true })));
  await rm(temp, { force: true });
}
