import { appendFile } from 'node:fs/promises';
import { resolveReusablePullRequest } from '../src/pull-request-binding.mjs';

const repository = process.env.TARGET_REPOSITORY;
const issueNumber = Number.parseInt(process.env.TARGET_ISSUE ?? '', 10);
const token = process.env.DELIVERY_GITHUB_READ_TOKEN || process.env.DELIVERY_GITHUB_WRITE_TOKEN;
const outputPath = process.env.GITHUB_OUTPUT;
if (!repository || !Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('TARGET_REPOSITORY and TARGET_ISSUE are required');
if (!outputPath) throw new Error('GITHUB_OUTPUT is required');

const binding = await resolveReusablePullRequest({ repository, issueNumber, token });
const pr = binding.pullRequest;
const outputs = {
  binding_status: binding.status,
  reuse_existing_pr: pr ? 'true' : 'false',
  bound_pull_request: pr ? String(pr.number) : '',
  bound_head_ref: pr?.head?.ref ?? '',
  bound_head_sha: pr?.head?.sha ?? '',
  binding_candidates: binding.candidates.map((item) => String(item.number)).join(',')
};
await appendFile(outputPath, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ status: binding.status, ...outputs }, null, 2));
