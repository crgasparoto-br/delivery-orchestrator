const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const issueNumber = Number.parseInt(process.env.CONTROL_ISSUE_NUMBER ?? '', 10);
const deliveryOutcome = process.env.DELIVERY_OUTCOME || 'unknown';
const runId = process.env.GITHUB_RUN_ID || 'unknown';

if (!Number.isInteger(issueNumber) || issueNumber < 1) {
  console.log('No control issue is bound to this run; nothing to finalize.');
  process.exit(0);
}
if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
if (deliveryOutcome === 'skipped') {
  console.log(`Control issue #${issueNumber} preserved because the delivery step was skipped.`);
  process.exit(0);
}

async function github(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

await github(`/issues/${issueNumber}/comments`, {
  method: 'POST',
  body: { body: `delivery-orchestrator run ${runId} finished the delivery step with outcome \`${deliveryOutcome}\`. This queue item is now consumed.` }
});
await github(`/issues/${issueNumber}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
console.log(`Closed consumed delivery request #${issueNumber}.`);
