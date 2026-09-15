import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateReleaseGate } from '../src/v2/release-gate.mjs';

const SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function input(hygiene, overrides={}) {
  return {
    schemaVersion:1,
    repository:'acme/example',
    pullRequestNumber:42,
    materialHeadSha:SHA,
    currentRemoteHeadSha:SHA,
    evidenceCollection:{materialHeadSha:SHA,remoteHeadSha:SHA,evidenceRef:'github:collection'},
    classifier:{subjectSha:SHA,profile:'fast',version:'v2',fingerprint:'fp',expectedFingerprint:'fp',evidenceRef:'artifact:classifier'},
    mergePreview:{required:false},
    checks:[{name:'Validate repository',required:true,subjectSha:SHA,status:'completed',conclusion:'success',workflowRunId:1,evidenceRef:'github:check'}],
    technicalHygieneRequired:true,
    technicalHygiene:hygiene,
    unresolvedFindings:[],
    blockers:[],
    ...overrides
  };
}

function hygiene(result='PASS', overrides={}) {
  return {schemaVersion:1,materialSha:SHA,baselineSha:OTHER,result,effectiveProfile:'fast',promotionRequired:false,missingEvidence:[],evidenceRef:'artifact:hygiene',...overrides};
}

test('release requires technical hygiene evidence when policy requires it',()=>{
  const result=evaluateReleaseGate(input(null));
  assert.equal(result.readiness,false);
  assert.deepEqual(result.reasons,['technical-hygiene-missing']);
});

test('stale technical hygiene cannot certify a new material commit',()=>{
  const result=evaluateReleaseGate(input(hygiene('PASS',{materialSha:OTHER})));
  assert.equal(result.state,'ci-pending');
  assert.deepEqual(result.reasons,['technical-hygiene-stale']);
});

test('PASS and PASS_WITH_DEBT are releasable hygiene states',()=>{
  assert.equal(evaluateReleaseGate(input(hygiene('PASS'))).readiness,true);
  assert.equal(evaluateReleaseGate(input(hygiene('PASS_WITH_DEBT'))).readiness,true);
});

test('BLOCK prevents release even when CI is green',()=>{
  const result=evaluateReleaseGate(input(hygiene('BLOCK')));
  assert.equal(result.state,'ci-failed-remediable');
  assert.deepEqual(result.reasons,['technical-hygiene-block']);
});

test('FAST material UNKNOWN promotes before release',()=>{
  const result=evaluateReleaseGate(input(hygiene('UNKNOWN',{effectiveProfile:'standard',promotionRequired:true,missingEvidence:[{code:'owner-unknown',detail:'owner not proven',material:true}]})));
  assert.equal(result.state,'classified');
  assert.deepEqual(result.reasons,['technical-hygiene-promote:standard']);
});

test('STANDARD material UNKNOWN remains release blocking',()=>{
  const classifier={subjectSha:SHA,profile:'standard',version:'v2',fingerprint:'fp',expectedFingerprint:'fp',evidenceRef:'artifact:classifier'};
  const result=evaluateReleaseGate(input(hygiene('UNKNOWN',{effectiveProfile:'standard',missingEvidence:[{code:'dup-unknown',detail:'equivalence not proven',material:true}]}),{classifier,standardAuditRequired:false}));
  assert.equal(result.state,'audit-failed-remediable');
  assert.deepEqual(result.reasons,['technical-hygiene-unknown-material']);
});
