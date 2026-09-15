import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryMetrics, summarizeDeliveryMetrics } from '../src/v2/metrics.mjs';

const SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function base(technicalHygiene) {
  return {
    repository:'acme/example',issueNumber:86,pullRequestNumber:42,materialHeadSha:SHA,risk:'fast',provider:'codex',
    classifier:{version:'v2',fingerprint:'fp'},providerCalls:1,attempts:{implementation:1,audit:0},aiUsage:{},providerCost:null,
    durationsMs:{ciQueue:0,ciExecution:1,audit:0,endToEnd:2},terminalReason:'ready-for-human-merge',
    change:{files:1,additions:1,deletions:0},escalated:false,evidenceRefs:['artifact:hygiene'],technicalHygiene
  };
}

test('technical hygiene telemetry is normalized without inflating AI usage',()=>{
  const record=createDeliveryMetrics(base({result:'PASS_WITH_DEBT',promoted:false,semanticCalls:0,evidenceRef:'artifact:hygiene'}));
  assert.equal(record.technicalHygiene.result,'PASS_WITH_DEBT');
  assert.equal(record.technicalHygiene.semanticCalls,0);
  assert.equal(record.aiUsage.totalTokens,null);
});

test('hygiene summaries expose block unknown promotions and semantic calls',()=>{
  const first=createDeliveryMetrics(base({result:'UNKNOWN',promoted:true,semanticCalls:1,evidenceRef:'artifact:hygiene-1'}));
  const second=createDeliveryMetrics({...base({result:'BLOCK',promoted:false,semanticCalls:0,evidenceRef:'artifact:hygiene-2'}),pullRequestNumber:43});
  const summary=summarizeDeliveryMetrics([first,second]).overall.technicalHygiene;
  assert.equal(summary.unknown,1);
  assert.equal(summary.block,1);
  assert.equal(summary.promotions,1);
  assert.equal(summary.semanticCalls,1);
});
