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

export function selectTrustedMarkerComment(comments, { marker, label, trustedLogin } = {}) {
  if (!Array.isArray(comments)) throw new Error('comments must be an array');
  const expectedMarker = requiredString(marker, 'marker');
  const expectedLabel = requiredString(label, 'label');
  const expectedLogin = requiredString(trustedLogin, 'trustedLogin').toLowerCase();
  const matching = comments.filter((comment) => String(comment?.body ?? '').startsWith(expectedMarker));
  const untrusted = matching.filter((comment) => {
    const login = String(comment?.user?.login ?? '').toLowerCase();
    const association = String(comment?.author_association ?? '').toUpperCase();
    return login !== expectedLogin || (association && !TRUSTED_ASSOCIATIONS.has(association));
  });
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
