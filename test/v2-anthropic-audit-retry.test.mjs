import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runAnthropic
} from '../src/role-runtime-worker.mjs';

const AUDIT_BUNDLE_FILES = [
  'AUDIT_REQUEST.json',
  'DELIVERY_CONTRACT.md',
  'ISSUE.json',
  'PULL_REQUEST.json',
  'CANDIDATE.diff',
  'DIFF_MANIFEST.json',
  'MATERIAL_CONTEXT.json'
];

async function createBundle() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'anthropic-audit-retry-')
  );

  for (const name of AUDIT_BUNDLE_FILES) {
    await writeFile(
      path.join(root, name),
      name.endsWith('.json') ? '{}' : 'fixture'
    );
  }

  return root;
}

function anthropicResponse(
  status,
  payload
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof payload === 'string'
        ? payload
        : JSON.stringify(payload);
    }
  };
}

function auditPayload(workingDirectory) {
  return {
    anthropicApiKey: 'test-key',
    model: 'claude-opus-test',
    workingDirectory,
    prompt: 'Audit the candidate.',
    outputSchema: {
      type: 'object'
    },
    role: 'auditor'
  };
}

test(
  'Claude audit retries one empty response and aggregates usage',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      const result = await runAnthropic(
        auditPayload(workingDirectory),
        {
          retryDelayMs: 0,
          fetchFn: async () => {
            calls += 1;

            if (calls === 1) {
              return anthropicResponse(200, {
                id: 'msg-empty',
                stop_reason: 'end_turn',
                content: [],
                usage: {
                  input_tokens: 10,
                  output_tokens: 0
                }
              });
            }

            return anthropicResponse(200, {
              id: 'msg-success',
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'text',
                  text: '{"decision":"approved"}'
                }
              ],
              usage: {
                input_tokens: 11,
                output_tokens: 3
              }
            });
          }
        }
      );

      assert.equal(calls, 2);
      assert.equal(result.providerCalls, 2);
      assert.deepEqual(
        result.usage,
        {
          inputTokens: 21,
          outputTokens: 3
        }
      );
      assert.deepEqual(
        result.result,
        {
          decision: 'approved'
        }
      );
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);


test(
  'Claude audit expands output budget when max_tokens exhausts the first attempt',
  async () => {
    const workingDirectory = await createBundle();
    const observedMaxTokens = [];
    let calls = 0;

    try {
      const result = await runAnthropic(
        auditPayload(workingDirectory),
        {
          retryDelayMs: 0,
          fetchFn: async (_url, options) => {
            calls += 1;

            const request = JSON.parse(options.body);
            observedMaxTokens.push(request.max_tokens);

            if (calls === 1) {
              return anthropicResponse(200, {
                id: 'msg-max-tokens',
                stop_reason: 'max_tokens',
                content: [],
                usage: {
                  input_tokens: 10,
                  output_tokens: 16000
                }
              });
            }

            return anthropicResponse(200, {
              id: 'msg-success-after-budget-growth',
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'text',
                  text: '{"decision":"approved"}'
                }
              ],
              usage: {
                input_tokens: 11,
                output_tokens: 3
              }
            });
          }
        }
      );

      assert.equal(calls, 2);
      assert.deepEqual(
        observedMaxTokens,
        [16000, 64000]
      );
      assert.equal(result.providerCalls, 2);
      assert.deepEqual(
        result.usage,
        {
          inputTokens: 21,
          outputTokens: 16003
        }
      );
      assert.deepEqual(
        result.result,
        {
          decision: 'approved'
        }
      );
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);


test(
  'Claude audit retries one transient fetch failure',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      const result = await runAnthropic(
        auditPayload(workingDirectory),
        {
          retryDelayMs: 0,
          fetchFn: async () => {
            calls += 1;

            if (calls === 1) {
              throw new TypeError('fetch failed');
            }

            return anthropicResponse(200, {
              id: 'msg-success-after-fetch-failure',
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'text',
                  text: '{"decision":"approved"}'
                }
              ],
              usage: {
                input_tokens: 9,
                output_tokens: 2
              }
            });
          }
        }
      );

      assert.equal(calls, 2);
      assert.equal(result.providerCalls, 2);
      assert.deepEqual(
        result.usage,
        {
          inputTokens: 9,
          outputTokens: 2
        }
      );
      assert.deepEqual(
        result.result,
        {
          decision: 'approved'
        }
      );
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'Claude audit retries one transient HTTP failure',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      const result = await runAnthropic(
        auditPayload(workingDirectory),
        {
          retryDelayMs: 0,
          fetchFn: async () => {
            calls += 1;

            if (calls === 1) {
              return anthropicResponse(
                503,
                {
                  error: {
                    type: 'overloaded_error'
                  }
                }
              );
            }

            return anthropicResponse(200, {
              id: 'msg-success',
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'text',
                  text: '{"decision":"approved"}'
                }
              ],
              usage: {
                input_tokens: 7,
                output_tokens: 2
              }
            });
          }
        }
      );

      assert.equal(calls, 2);
      assert.equal(result.providerCalls, 2);
      assert.deepEqual(
        result.usage,
        {
          inputTokens: 7,
          outputTokens: 2
        }
      );
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'Claude audit fails closed after two empty responses',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      let failure;

      try {
        await runAnthropic(
          auditPayload(workingDirectory),
          {
            retryDelayMs: 0,
            fetchFn: async () => {
              calls += 1;

              return anthropicResponse(200, {
                id: `msg-${calls}`,
                stop_reason: 'end_turn',
                content: [],
                usage: {
                  input_tokens: 5,
                  output_tokens: 0
                }
              });
            }
          }
        );
      } catch (error) {
        failure = error;
      }

      assert.match(
        failure?.message ?? '',
        /empty final response after 2 attempts/
      );
      assert.equal(failure?.auditProviderFailure, true);
      assert.equal(failure?.providerCalls, 2);
      assert.deepEqual(
        failure?.modelUsage,
        {
          inputTokens: 10,
          outputTokens: 0
        }
      );
      assert.equal(calls, 2);
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'Claude audit does not retry invalid model JSON',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      await assert.rejects(
        () =>
          runAnthropic(
            auditPayload(workingDirectory),
            {
              retryDelayMs: 0,
              fetchFn: async () => {
                calls += 1;

                return anthropicResponse(200, {
                  id: 'msg-invalid',
                  stop_reason: 'end_turn',
                  content: [
                    {
                      type: 'text',
                      text: 'not-json'
                    }
                  ],
                  usage: {
                    input_tokens: 5,
                    output_tokens: 1
                  }
                });
              }
            }
          ),
        /returned invalid JSON/
      );

      assert.equal(calls, 1);
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'GitHub-native audit persists dynamic providerCalls',
  async () => {
    const runner = await readFile(
      new URL(
        '../scripts/run-delivery-v2-github-audit.mjs',
        import.meta.url
      ),
      'utf8'
    );

    assert.match(
      runner,
      /Number\.isInteger\(response\.providerCalls\)/
    );

    assert.match(
      runner,
      /providerCalls,\s*reviewerContextId/
    );

    assert.match(
      runner,
      /decision: finalized\.result\.decision,\s*providerCalls,/
    );
  }
);


test(
  'GitHub-native runner preserves provider failure telemetry before fail-closed',
  async () => {
    const runner = await readFile(
      new URL(
        '../scripts/run-delivery-v2-github-audit.mjs',
        import.meta.url
      ),
      'utf8'
    );

    assert.match(
      runner,
      /status:\s*'audit-provider-failed'/
    );
    assert.match(
      runner,
      /providerCalls,\s*reviewerContextId:\s*null/
    );
    assert.match(
      runner,
      /modelUsage:\s*error\.modelUsage\s*\?\?\s*null/
    );
  }
);


test(
  'Claude audit converts repeated fetch failures into provider failure telemetry',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      let failure;

      try {
        await runAnthropic(
          auditPayload(workingDirectory),
          {
            retryDelayMs: 0,
            fetchFn: async () => {
              calls += 1;
              throw new TypeError('fetch failed');
            }
          }
        );
      } catch (error) {
        failure = error;
      }

      assert.equal(calls, 2);

      assert.match(
        failure?.message ?? '',
        /Anthropic audit transport failed after 2 call\(s\): fetch failed/
      );

      assert.equal(
        failure?.auditProviderFailure,
        true
      );

      assert.equal(
        failure?.providerCalls,
        2
      );

      assert.equal(
        failure?.modelUsage,
        null
      );
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'Claude audit preserves provider telemetry after two transient HTTP failures',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      let failure;

      try {
        await runAnthropic(
          auditPayload(workingDirectory),
          {
            retryDelayMs: 0,
            fetchFn: async () => {
              calls += 1;

              return anthropicResponse(
                503,
                {
                  error: {
                    type: 'overloaded_error'
                  }
                }
              );
            }
          }
        );
      } catch (error) {
        failure = error;
      }

      assert.match(
        failure?.message ?? '',
        /Anthropic audit invocation failed \(503\) after 2 call\(s\)/
      );
      assert.equal(
        failure?.auditProviderFailure,
        true
      );
      assert.equal(
        failure?.providerCalls,
        2
      );
      assert.equal(
        failure?.modelUsage,
        null
      );
      assert.equal(
        calls,
        2
      );
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'Claude audit preserves provider telemetry for invalid model JSON without retry',
  async () => {
    const workingDirectory = await createBundle();
    let calls = 0;

    try {
      let failure;

      try {
        await runAnthropic(
          auditPayload(workingDirectory),
          {
            retryDelayMs: 0,
            fetchFn: async () => {
              calls += 1;

              return anthropicResponse(200, {
                id: 'msg-invalid-telemetry',
                stop_reason: 'end_turn',
                content: [
                  {
                    type: 'text',
                    text: 'not-json'
                  }
                ],
                usage: {
                  input_tokens: 5,
                  output_tokens: 1
                }
              });
            }
          }
        );
      } catch (error) {
        failure = error;
      }

      assert.match(
        failure?.message ?? '',
        /returned invalid JSON/
      );
      assert.equal(
        failure?.auditProviderFailure,
        true
      );
      assert.equal(
        failure?.providerCalls,
        1
      );
      assert.deepEqual(
        failure?.modelUsage,
        {
          inputTokens: 5,
          outputTokens: 1
        }
      );
      assert.equal(
        calls,
        1
      );
    } finally {
      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);
