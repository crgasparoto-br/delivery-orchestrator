const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(label + ' is required');
  return result;
}

function requiredPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(label + ' must be a positive integer');
  return result;
}

export function trustedCommentAuthorForRepository(repository) {
  const value = requiredString(repository, 'repository');
  const owner = value.split('/')[0];
  if (!owner) throw new Error('repository must use owner/name form');
  return owner.toLowerCase();
}

export function isTrustedRepositoryAuthor(value, trustedLogin, { allowMissingAssociation = false } = {}) {
  const expectedLogin = requiredString(trustedLogin, 'trustedLogin').toLowerCase();
  const login = String(value?.user?.login ?? '').toLowerCase();
  const association = String(value?.author_association ?? '').toUpperCase();
  return login === expectedLogin && (TRUSTED_ASSOCIATIONS.has(association) || (allowMissingAssociation && !association));
}

// Only explicit closing references outside code, quotes and hidden comments bind a PR.
// A second closing target is ambiguous even when one reference names our issue.
function closingTargets(body, repository) {
  const text = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/`[^`\n]*`/g, '');
  const references = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)#|#)([1-9]\d*)\b/gi;
  return [...text.matchAll(references)].map((match) => `${(match[1] ?? match[2] ?? repository).toLowerCase()}#${match[3]}`);
}

export function selectExistingPullRequest(pulls, { repository, issueNumber, baseBranch, trustedLogin } = {}) {
  if (!Array.isArray(pulls)) throw new Error('pulls must be an array');
  const expectedRepository = requiredString(repository, 'repository').toLowerCase();
  const issue = requiredPositiveInteger(issueNumber, 'issueNumber');
  const base = requiredString(baseBranch, 'baseBranch');
  const author = requiredString(trustedLogin, 'trustedLogin');
  const target = `${expectedRepository}#${issue}`;
  const linked = pulls.filter((pr) => closingTargets(pr?.body, expectedRepository).includes(target));
  if (linked.length > 1) throw new Error(`multiple open PRs found for issue #${issue}; refusing ambiguous adoption`);
  if (!linked.length) return null;
  const pr = linked[0];
  if (new Set(closingTargets(pr.body, expectedRepository)).size !== 1) throw new Error('PR closing references are ambiguous');
  if (pr.state !== 'open') throw new Error('existing PR must have explicit open state');
  if (!isTrustedRepositoryAuthor(pr, author)) throw new Error('existing PR author is not trusted');
  if (String(pr.base?.repo?.full_name ?? '').toLowerCase() !== expectedRepository
      || String(pr.head?.repo?.full_name ?? '').toLowerCase() !== expectedRepository) throw new Error('existing PR repository mismatch or fork');
  if (pr.base?.ref !== base) throw new Error('existing PR base branch mismatch');
  requiredPositiveInteger(pr.number, 'pullRequest.number');
  requiredString(pr.head?.ref, 'pullRequest.head.ref');
  for (const side of ['base', 'head']) {
    if (!/^[0-9a-f]{40}$/i.test(String(pr[side]?.sha ?? ''))) throw new Error(`existing PR ${side} requires an exact Git SHA`);
  }
  return pr;
}

export function selectTrustedMarkerComment(comments, { marker, label, trustedLogin } = {}) {
  if (!Array.isArray(comments)) throw new Error('comments must be an array');
  const expectedMarker = requiredString(marker, 'marker');
  const expectedLabel = requiredString(label, 'label');
  const expectedLogin = requiredString(trustedLogin, 'trustedLogin').toLowerCase();
  const matching = comments.filter((comment) => String(comment?.body ?? '').startsWith(expectedMarker));
  const untrusted = matching.filter((comment) => !isTrustedRepositoryAuthor(comment, expectedLogin, { allowMissingAssociation: true }));
  if (untrusted.length > 0) throw new Error('untrusted ' + expectedLabel + ' marker comment found; refusing controller state recovery');
  if (matching.length === 0) return null;
  if (matching.length > 1) throw new Error('multiple ' + expectedLabel + ' comments found; refusing ambiguous recovery');
  return matching[0];
}

export function parseTrustedJsonEnvelope(comments, { marker, label, trustedLogin } = {}) {
  const comment = selectTrustedMarkerComment(comments, { marker, label, trustedLogin });
  if (!comment) return null;
  const body = String(comment.body ?? '');
  const fenced = body.match(/```json\s*([\s\S]*?)\s*```/);
  if (!fenced) throw new Error(String(label) + ' comment is missing its JSON envelope');
  return Object.freeze({ commentId: comment.id ?? null, userLogin: String(comment.user?.login ?? ''), value: JSON.parse(fenced[1]) });
}

export function validateControllerRunProvenance(run, { orchestratorRepository, trustedRef, workflowPath = '.github/workflows/delivery-v2-dispatch.yml' } = {}) {
  if (!run || Array.isArray(run) || typeof run !== 'object') throw new Error('controller workflow run is required');
  requiredPositiveInteger(run.id, 'controller workflow run id');
  const repository = requiredString(orchestratorRepository, 'orchestratorRepository');
  if (String(run.repository?.full_name ?? '') !== repository) throw new Error('controller workflow run repository mismatch');
  if (String(run.event ?? '') !== 'workflow_dispatch') throw new Error('controller workflow run event mismatch');
  if (String(run.path ?? '') !== requiredString(workflowPath, 'workflowPath')) throw new Error('controller workflow path mismatch');
  if (String(run.head_branch ?? '') !== requiredString(trustedRef, 'trustedRef')) throw new Error('controller workflow trusted ref mismatch');
  return Object.freeze({ runId: Number(run.id), repository, workflowPath: String(run.path), trustedRef: String(run.head_branch) });
}
