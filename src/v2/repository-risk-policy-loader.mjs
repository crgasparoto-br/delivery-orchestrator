import { readFile, readdir } from 'node:fs/promises';

export async function loadRepositoryRiskPolicy(repository, { configDir = new URL('../../config/delivery-v2-targets/', import.meta.url) } = {}) {
  const target = String(repository ?? '').trim();
  if (!target) return {};
  for (const name of (await readdir(configDir)).filter((item) => item.endsWith('.json'))) {
    const config = JSON.parse(await readFile(new URL(name, configDir), 'utf8'));
    if (config.repository === target) return config.riskPolicy ?? {};
  }
  return {};
}
