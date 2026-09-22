import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTechnicalHygiene } from '../src/v2/technical-hygiene.mjs';

const BASE='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PREV='cccccccccccccccccccccccccccccccccccccccc';
const ev=(x)=>[`path:${x}`];
const base=(overrides={})=>({schemaVersion:1,profile:'fast',baselineSha:BASE,materialSha:HEAD,evidenceRef:'artifact:hygiene',reuseDiscovery:[{symbol:'existingHelper',decision:'REUSE_EXISTING',evidence:ev('helper')}],structuralFindings:[],semanticJudgments:[],deterministicReferences:[],missingEvidence:[],...overrides});

test('reuse existing helper passes',()=>assert.equal(evaluateTechnicalHygiene(base()).result,'PASS'));
test('known owner plus unjustified create blocks',()=>assert.equal(evaluateTechnicalHygiene(base({reuseDiscovery:[{symbol:'FooServiceV2',decision:'CREATE_NEW',evidence:ev('new'),existingOwnerEvidence:ev('FooService')}]})).result,'BLOCK'));
test('textual similarity without material semantic decision does not block',()=>assert.equal(evaluateTechnicalHygiene(base({structuralFindings:[{kind:'textual-similarity',material:true,evidence:ev('pair')}]})).result,'PASS'));
test('large file small cohesive change can preserve preexisting debt',()=>assert.equal(evaluateTechnicalHygiene(base({structuralFindings:[{kind:'file-growth',material:true,preexisting:true,evidence:ev('large')},{kind:'file-growth',material:true,evidence:ev('delta'),newResponsibilities:false,complexityIncreased:false,cohesive:true}]})).result,'PASS_WITH_DEBT'));
test('material growth with new responsibility and complexity blocks',()=>assert.equal(evaluateTechnicalHygiene(base({structuralFindings:[{kind:'file-growth',material:true,evidence:ev('delta'),newResponsibilities:true,complexityIncreased:true}]})).result,'BLOCK'));
test('cohesive split is not blocked by file count alone',()=>assert.equal(evaluateTechnicalHygiene(base({structuralFindings:[{kind:'created-files',material:true,evidence:ev('split')}]})).result,'PASS'));
test('second fallback without root cause blocks',()=>assert.equal(evaluateTechnicalHygiene(base({structuralFindings:[{kind:'fallback',ordinal:2,material:true,evidence:ev('fallback')}]})).result,'BLOCK'));
test('remediation can compare prior material while accumulated duplication blocks',()=>{const r=evaluateTechnicalHygiene(base({previousMaterialSha:PREV,structuralFindings:[{kind:'duplication',material:true,evidence:ev('accumulated')}]}));assert.equal(r.previousMaterialSha,PREV);assert.equal(r.result,'BLOCK')});
test('deterministic reference overrides unsupported dead-code claim',()=>{const r=evaluateTechnicalHygiene(base({semanticJudgments:[{claim:'usedFn',claimKind:'dead-code',decision:'DEAD_CODE',material:true,evidence:[]}],deterministicReferences:[{symbol:'usedFn',referenced:true,evidence:ev('import')}]}));assert.equal(r.result,'PASS');assert.equal(r.overriddenSemanticClaims.length,1)});
test('FAST material missing evidence becomes UNKNOWN and promotes STANDARD',()=>{const r=evaluateTechnicalHygiene(base({missingEvidence:[{code:'owner-unknown',detail:'owner not proven',material:true}]}));assert.equal(r.result,'UNKNOWN');assert.equal(r.promotionRequired,true);assert.equal(r.effectiveProfile,'standard')});
test('STANDARD material UNKNOWN blocks release',()=>{const r=evaluateTechnicalHygiene(base({profile:'standard',missingEvidence:[{code:'dup-unknown',detail:'semantic equivalence unknown',material:true}]}));assert.equal(r.result,'UNKNOWN');assert.equal(r.releaseAllowed,false)});
test('preexisting debt without new regression is PASS_WITH_DEBT',()=>assert.equal(evaluateTechnicalHygiene(base({structuralFindings:[{kind:'avoidable-complexity',preexisting:true,material:true,evidence:ev('baseline')}]})).result,'PASS_WITH_DEBT'));
test('legitimate create with known owner evidence requires justification and may pass',()=>assert.equal(evaluateTechnicalHygiene(base({reuseDiscovery:[{symbol:'NewAdapter',decision:'CREATE_NEW',material:true,evidence:ev('new'),existingOwnerEvidence:ev('owner'),justificationEvidence:ev('srp')}]})).result,'PASS'));
test('missing complexity tool alone does not create UNKNOWN',()=>assert.equal(evaluateTechnicalHygiene(base({localPolicy:{tools:[],thresholds:{},severityPromotions:[]}})).result,'PASS'));
test('material SHA is part of the immutable result identity',()=>assert.equal(evaluateTechnicalHygiene(base()).materialSha,HEAD));
test('local policy cannot weaken central invariants',()=>assert.throws(()=>evaluateTechnicalHygiene(base({localPolicy:{unknownMaterialAs:'warning'}})),/cannot override central hygiene invariant/));
test('material semantic claim without evidence becomes UNKNOWN',()=>assert.equal(evaluateTechnicalHygiene(base({semanticJudgments:[{claim:'shared owner',decision:'REUSE_EXISTING',material:true,evidence:[]}]})).result,'UNKNOWN'));


test('compact structural register preserves created files and symbols',()=>{const r=evaluateTechnicalHygiene(base({createdFiles:['src/new-helper.mjs'],reuseDiscovery:[{symbol:'NewHelper',decision:'CREATE_NEW',material:true,evidence:ev('new'),justificationEvidence:ev('owner')}]}));assert.deepEqual(r.createdFiles,['src/new-helper.mjs']);assert.deepEqual(r.createdSymbols,['NewHelper'])});


test('unknown structural finding kind fails closed as UNKNOWN', () => {
  const result = evaluateTechnicalHygiene(
    base({
      structuralFindings: [
        {
          kind: 'parallel-implementation',
          material: true,
          evidence: ev('parallel')
        }
      ]
    })
  );

  assert.equal(result.result, 'UNKNOWN');
  assert.equal(result.releaseAllowed, false);

  assert.ok(
    result.missingEvidence.some(
      (entry) => entry.code === 'structural-unknown-kind'
    )
  );
});

test('malformed structural ordinal fails closed instead of neutralizing fallback rule', () => {
  const result = evaluateTechnicalHygiene(
    base({
      structuralFindings: [
        {
          kind: 'fallback',
          ordinal: 'two',
          material: true,
          evidence: ev('fallback')
        }
      ]
    })
  );

  assert.equal(result.result, 'UNKNOWN');

  assert.ok(
    result.missingEvidence.some(
      (entry) => entry.code === 'structural-malformed-fields'
    )
  );
});

test('string structural booleans fail closed instead of silently coercing semantics', () => {
  const result = evaluateTechnicalHygiene(
    base({
      structuralFindings: [
        {
          kind: 'file-growth',
          material: true,
          evidence: ev('growth'),
          newResponsibilities: 'true',
          complexityIncreased: 'true'
        }
      ]
    })
  );

  assert.equal(result.result, 'UNKNOWN');

  assert.ok(
    result.missingEvidence.some(
      (entry) =>
        entry.code === 'structural-malformed-fields' &&
        entry.detail.includes('newResponsibilities') &&
        entry.detail.includes('complexityIncreased')
    )
  );
});
