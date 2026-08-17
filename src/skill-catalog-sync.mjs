import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

async function walkFiles(root, current = root, out = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await walkFiles(root, absolute, out);
    else if (entry.isFile()) out.push(absolute);
    else throw new Error(`skill catalog contains unsupported filesystem entry: ${absolute}`);
  }
  return out;
}

export async function directoryDigest(root) {
  const files = await walkFiles(root);
  files.sort((a, b) => {
    const left = path.relative(root, a).split(path.sep).join('/');
    const right = path.relative(root, b).split(path.sep).join('/');
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const digest = createHash('sha256');
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const content = await readFile(file);
    digest.update(relative);
    digest.update('\0');
    digest.update(createHash('sha256').update(content).digest('hex'));
    digest.update('\n');
  }
  return { digest: `sha256:${digest.digest('hex')}`, files: files.length };
}

export async function verifySynchronizedSkillCatalog(root) {
  const skillsRoot = path.join(root, 'skills');
  const catalogRoot = path.join(skillsRoot, 'catalog');
  const manifestPath = path.join(skillsRoot, 'catalog.sync-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.source !== 'chatgpt-web-installed-skills' || !manifest.skills || typeof manifest.skills !== 'object') {
    throw new Error('invalid synchronized skill catalog manifest');
  }

  const actualNames = (await readdir(catalogRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const expectedNames = Object.keys(manifest.skills).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`synchronized skill catalog membership mismatch: expected ${expectedNames.join(', ')}, got ${actualNames.join(', ')}`);
  }

  for (const name of expectedNames) {
    const actual = await directoryDigest(path.join(catalogRoot, name));
    const expected = manifest.skills[name];
    if (actual.digest !== expected.digest || actual.files !== expected.files) {
      throw new Error(`synchronized skill ${name} does not match manifest`);
    }
  }
  return { skills: expectedNames };
}
