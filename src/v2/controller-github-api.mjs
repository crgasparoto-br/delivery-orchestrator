import { withTransientFetchRetry } from './github-api-retry.mjs';

export function githubHeaders(token, userAgent) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent
  };
}

export async function githubApi(url, token, { userAgent = 'delivery-v2-controller', ...options } = {}) {
  return withTransientFetchRetry(async () => {
    const response = await fetch(url, {
      ...options,
      headers: { ...githubHeaders(token, userAgent), ...(options.headers ?? {}) }
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} ${options.method ?? 'GET'} ${url}: ${await response.text()}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }, { label: `${options.method ?? 'GET'} ${url}` });
}

export async function listAllGithub(url, token, options = {}) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const join = url.includes('?') ? '&' : '?';
    const batch = await githubApi(`${url}${join}per_page=100&page=${page}`, token, options);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}
