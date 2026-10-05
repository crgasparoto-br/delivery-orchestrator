import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changedPathsFromGitPatch, downloadGhAwAgentOutputArtifact } from '../src/v2/gh-aw-agent-output-artifact.mjs';
import { createWorkerScopeBinding, assertChangedPathsAuthorized, materialPathsFromGitPatch } from '../.github/scripts/delivery-v2-worker-scope-contract.mjs';
import { recoveryContextForScopeCorrection } from '../scripts/guard-delivery-v2-reentry.mjs';

const repository = 'owner/repo';
const issue = { number: 63, title: 'Scope correction', body: 'Same contract' };
const binding = (authorizedPaths) => createWorkerScopeBinding({ repository, issue, authorizedPaths });
const editPatch = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

function recover(artifact, oldPaths, newPaths) {
  return recoveryContextForScopeCorrection({
    bootstrapLease: {
      repository, issueNumber: issue.number, implementationAttempts: 1,
      status: 'escalated-initial-nonrecoverable', scopeBinding: binding(oldPaths),
      lastFailure: { failureStage: 'pre-material', hasPatch: true, materialPublished: false, workerRunId: 388 }
    },
    scopeGuardFailure: { classification: 'material-scope-guard-rejected-local-patch', workerRunId: 388 },
    observedPatch: { ...artifact, materialPublished: false },
    correctedScopeBinding: binding(newPaths)
  });
}

async function withPatch(patch, action) {
  const root = await mkdtemp(path.join(tmpdir(), 'dv2-patch-scope-'));
  try {
    const file = path.join(root, 'candidate.patch');
    await writeFile(file, patch);
    return await action(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const kind of ['rename', 'copy']) {
  for (const [label, source, target, sourceHeader, targetHeader] of [
    ['plain', 'private/source.mjs', 'src/result.mjs', 'private/source.mjs', 'src/result.mjs'],
    ['tab', 'private/source\tfile.mjs', 'src/result\tfile.mjs', '"private/source\\tfile.mjs"', '"src/result\\tfile.mjs"'],
    ['UTF-8', 'private/caf\u00e9.mjs', 'src/caf\u00e9.mjs', '"private/caf\\303\\251.mjs"', '"src/caf\\303\\251.mjs"']
  ]) {
    test(`${kind} ${label}: recovery and authorization require both source and destination`, async () => {
      const patch = `diff --git a/placeholder b/placeholder\nsimilarity index 100%\n${kind} from ${sourceHeader}\n${kind} to ${targetHeader}\n`;
      await withPatch(patch, (file) => {
        const changedPaths = changedPathsFromGitPatch(file);
        assert.deepEqual(changedPaths, [source, target].sort());
        assert.throws(() => assertChangedPathsAuthorized(changedPaths, binding([target])), /escapes/);
        assert.equal(recover({ hasPatch: true, changedPaths }, [source], [target]), null);
        const accepted = recover({ hasPatch: true, changedPaths }, [source], [source, target]);
        assert.equal(accepted.retryMode, 'reuse-current-attempt');
        assert.equal(accepted.grantedImplementationAttempts, 0);
        assert.equal(recover({ hasPatch: true, changedPaths }, [source, target], [source, target]), null);
      });
    });
  }
}

test('NUL-delimited numstat preserves an embedded tab rather than treating it as another column', async () => {
  const patch = 'diff --git "a/src/a\\tb.mjs" "b/src/a\\tb.mjs"\n--- "a/src/a\\tb.mjs"\n+++ "b/src/a\\tb.mjs"\n@@ -1 +1 @@\n-old\n+new\n';
  await withPatch(patch, (file) => assert.deepEqual(changedPathsFromGitPatch(file), ['src/a\tb.mjs']));
});

for (const [name, patch] of [['empty', ''], ['malformed', 'not a Git patch\n']]) {
  test(`${name} patch cannot yield authoritative material paths`, async () => {
    await withPatch(patch, (file) => assert.throws(() => changedPathsFromGitPatch(file)));
  });
}

test('shared parser rejects traversal, ambiguous boundary whitespace and malformed stat records', () => {
  for (const stat of ['1\t0\t../outside\0', '1\t0\t src/file \0', 'bad\t0\tsrc/file\0', '1\t0\0', '']) {
    assert.throws(() => materialPathsFromGitPatch('', Buffer.from(stat)));
  }
});

// Mock only the HTTP boundary. ZIP extraction, git inspection, scope policy and
// recovery selection use production code, without credentials or workflow runs.
async function withArtifact(files, action, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dv2-artifact-scope-'));
  const originalFetch = globalThis.fetch;
  try {
    const entries = { 'agent_output.json': '{"items":[]}\n', ...files };
    for (const [name, content] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }
    execFileSync('zip', ['-q', path.join(root, 'agent.zip'), ...Object.keys(entries)], { cwd: root });
    const bytes = options.invalidZip ? Buffer.from('invalid zip') : await readFile(path.join(root, 'agent.zip'));
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/artifacts?per_page=100')) {
        return new Response(JSON.stringify(options.inventory ?? { artifacts: [{ id: 123, name: 'agent', archive_download_url: 'fixture:123' }] }));
      }
      assert.ok(String(url).endsWith('/artifacts/123/zip'), 'no unexpected outbound request');
      return new Response(bytes);
    };
    const artifact = await downloadGhAwAgentOutputArtifact({ repository, runId: 388, token: 'fixture-only' });
    assert.ok(requests.length <= 2, 'artifact inspection must not dispatch/probe providers');
    return await action(artifact, requests);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
}

test('one patch with multiple paths remains eligible, with the same attempt budget', async () => {
  await withArtifact({ 'aw-one.patch': editPatch('src/a.mjs') + editPatch('src/b.mjs') }, (artifact) => {
    assert.equal(artifact.hasPatch, true);
    assert.deepEqual(artifact.changedPaths, ['src/a.mjs', 'src/b.mjs']);
    assert.equal(recover(artifact, ['src/a.mjs'], artifact.changedPaths).grantedImplementationAttempts, 0);
  });
});

for (const [name, files] of [
  ['two candidates', { 'aw-one.patch': editPatch('src/a.mjs'), 'aw-two.patch': editPatch('src/b.mjs') }],
  ['duplicate candidates in subdirectories', { 'one/aw-one.patch': editPatch('src/a.mjs'), 'two/aw-one.patch': editPatch('src/a.mjs') }],
  ['unrecognized candidate name', { 'candidate.patch': editPatch('src/a.mjs') }],
  ['additional non-aw patch', { 'aw-one.patch': editPatch('src/a.mjs'), 'candidate.patch': editPatch('src/b.mjs') }],
  ['duplicate agent output', { 'aw-one.patch': editPatch('src/a.mjs'), 'nested/agent_output.json': '{"items":[]}' }],
  ['empty candidate', { 'aw-one.patch': '' }],
  ['malformed candidate', { 'aw-one.patch': 'not a patch' }],
  ['malformed agent output', { 'aw-one.patch': editPatch('src/a.mjs'), 'agent_output.json': '{' }]
]) {
  test(`${name} fails closed without authorizing recovery`, async () => {
    await withArtifact(files, (artifact) => {
      assert.equal(artifact.hasPatch, null);
      assert.ok(artifact.error);
      assert.equal(recover(artifact, ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']), null);
    });
  });
}

test('an authoritative archive with zero patches preserves no-patch evidence but cannot recover scope', async () => {
  await withArtifact({}, (artifact) => {
    assert.equal(artifact.hasPatch, false);
    assert.deepEqual(artifact.changedPaths, []);
    assert.equal(recover(artifact, ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']), null);
  });
});

for (const [name, inventory] of [
  ['duplicate primary artifacts', { artifacts: [{ id: 123, name: 'agent' }, { id: 124, name: 'agent' }] }],
  ['incomplete inventory', { total_count: 2, artifacts: [{ id: 123, name: 'agent' }] }],
  ['malformed inventory', { artifacts: null }],
  ['expired artifact', { artifacts: [{ id: 123, name: 'agent', expired: true }] }]
]) {
  test(`${name} does not download or authorize a candidate`, async () => {
    await withArtifact({}, (artifact, requests) => {
      assert.equal(requests.length, 1);
      assert.equal(artifact.hasPatch, null);
      assert.ok(artifact.error);
      assert.equal(recover(artifact, ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']), null);
    }, { inventory });
  });
}

test('fallback output cannot prove a material patch even when it contains a patch file', async () => {
  await withArtifact({ 'aw-one.patch': editPatch('src/a.mjs') }, (artifact) => {
    assert.equal(artifact.hasPatch, null);
    assert.equal(artifact.changedPaths, null);
    assert.equal(recover(artifact, ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']), null);
  }, { inventory: { artifacts: [{ id: 123, name: 'agent-output-fallback' }] } });
});

test('malformed ZIP is unknown evidence, never an authoritative negative or scope correction', async () => {
  await withArtifact({}, (artifact) => {
    assert.equal(artifact.hasPatch, null);
    assert.ok(artifact.error);
    assert.equal(recover(artifact, ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']), null);
  }, { invalidZip: true });
});
