function tokenRegex(issueNumber) {
  return new RegExp(`(?:^|[-_/])${issueNumber}(?:[-_/]|$)`);
}

function scorePullRequest(pr, issueNumber) {
  if (!pr || pr.state !== 'open') return 0;
  const body = String(pr.body ?? '');
  const title = String(pr.title ?? '');
  const head = String(pr.head?.ref ?? '');
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const closing = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*#${escaped}\\b`, 'i');
  const related = new RegExp(`\\b(?:refs?|related\\s+to)\\s*#${escaped}\\b`, 'i');
  const anyRef = new RegExp(`#${escaped}\\b`, 'i');
  if (closing.test(body)) return 100;
  if (related.test(body)) return 80;
  if (anyRef.test(title)) return 70;
  if (tokenRegex(issueNumber).test(head)) return 60;
  if (anyRef.test(body)) return 40;
  return 0;
}

export function selectReusablePullRequest(pulls, issueNumber) {
  const candidates = pulls
    .map((pr) => ({ pr, score: scorePullRequest(pr, issueNumber) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || Number(a.pr.number) - Number(b.pr.number));

  if (candidates.length === 0) return { status: 'none', pullRequest: null, candidates: [] };
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return { status: 'ambiguous', pullRequest: null, candidates: candidates.map(({ pr, score }) => ({ number: pr.number, score })) };
  }
  return { status: 'bound', pullRequest: candidates[0].pr, candidates: candidates.map(({ pr, score }) => ({ number: pr.number, score })) };
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) throw new Error(`GitHub request failed ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function resolveReusablePullRequest({ repository, issueNumber, token, fetchImpl = fetch }) {
  if (!token) throw new Error('GitHub token is required to resolve reusable pull requests');
  const [owner, repo] = repository.split('/');
  const pulls = await githubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`, token, fetchImpl);
  return selectReusablePullRequest(pulls, issueNumber);
}
