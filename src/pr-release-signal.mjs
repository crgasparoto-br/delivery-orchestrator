export const RELEASE_SIGNAL_MARKER = '<!-- delivery-orchestrator:independent-release-gate -->';

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function githubJson(url, { token, method = 'GET', body, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...githubHeaders(token),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`GitHub request failed ${response.status}: ${await response.text()}`);
  return response.json();
}

export function isIndependentReleaseApproved(audit) {
  return Boolean(
    audit &&
    (audit.status === 'approved' || audit.status === 'approved_with_reservations') &&
    audit.validity === 'independent' &&
    audit.release_gate_satisfied === true
  );
}

export function renderIndependentReleaseComment({ audit, materialHeadSha, handoffHeadSha }) {
  const verdict = audit.status === 'approved_with_reservations' ? 'APROVADA COM RESSALVAS' : 'APROVADA';
  return `${RELEASE_SIGNAL_MARKER}\n## ✅ AUDITORIA INDEPENDENTE ${verdict} — PR LIBERADA PARA MERGE\n\n| Campo | Valor |\n|---|---|\n| Validade | \`independent\` |\n| Resultado | \`${audit.status}\` |\n| Release gate | \`true\` |\n| Material SHA auditado | \`${materialHeadSha}\` |\n| PR head SHA validado | \`${handoffHeadSha}\` |\n| Estado | \`ready-for-human-merge\` |\n\n> Esta liberação é válida somente enquanto o head da PR permanecer exatamente em \`${handoffHeadSha}\`. Qualquer novo commit invalida este sinal e exige nova auditoria independente.\n\nNenhum merge foi executado automaticamente pelo delivery-orchestrator.`;
}

export async function publishIndependentAuditReleaseSignal({
  repository,
  pullRequestNumber,
  expectedHeadSha,
  materialHeadSha,
  audit,
  token,
  fetchImpl = fetch
}) {
  if (!token) throw new Error('GitHub write token is required to publish the independent audit release signal');
  if (!isIndependentReleaseApproved(audit)) {
    return { published: false, reason: 'audit-not-releasable' };
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error('repository must be owner/repo');
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const pr = await githubJson(`${baseUrl}/pulls/${pullRequestNumber}`, { token, fetchImpl });
  const observedHeadSha = pr.head?.sha ?? null;
  if (pr.state !== 'open') {
    return { published: false, reason: 'pull-request-not-open', pull_request: pullRequestNumber, observed_head_sha: observedHeadSha };
  }
  if (!expectedHeadSha || observedHeadSha !== expectedHeadSha) {
    return {
      published: false,
      reason: 'head-mismatch',
      pull_request: pullRequestNumber,
      expected_head_sha: expectedHeadSha ?? null,
      observed_head_sha: observedHeadSha
    };
  }

  const body = renderIndependentReleaseComment({ audit, materialHeadSha, handoffHeadSha: expectedHeadSha });
  const comments = await githubJson(`${baseUrl}/issues/${pullRequestNumber}/comments?per_page=100`, { token, fetchImpl });
  const existing = comments.find((comment) => String(comment.body ?? '').includes(RELEASE_SIGNAL_MARKER));
  const comment = existing
    ? await githubJson(`${baseUrl}/issues/comments/${existing.id}`, { token, method: 'PATCH', body: { body }, fetchImpl })
    : await githubJson(`${baseUrl}/issues/${pullRequestNumber}/comments`, { token, method: 'POST', body: { body }, fetchImpl });

  return {
    published: true,
    action: existing ? 'updated' : 'created',
    pull_request: pullRequestNumber,
    comment_id: comment.id ?? null,
    comment_url: comment.html_url ?? null,
    expected_head_sha: expectedHeadSha,
    observed_head_sha: observedHeadSha,
    material_head_sha: materialHeadSha,
    audit_status: audit.status,
    audit_validity: audit.validity,
    release_gate_satisfied: true
  };
}
