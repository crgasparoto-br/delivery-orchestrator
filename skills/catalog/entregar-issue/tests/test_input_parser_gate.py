from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from orchestrator_gate.evidence_validation import required_families, validate_input_parser_contract
from orchestrator_gate.risk_detection import detect
from orchestrator_gate.risk_validation import validate_risk

CONTROL_IDS = ["IP-RAW-001", "IP-MODE-001", "IP-SCOPE-001", "IP-INACTIVE-001", "IP-EFFECT-001"]

class InputParserGateTests(unittest.TestCase):
    def test_detector_marks_parser_path_as_high_risk(self):
        with tempfile.TemporaryDirectory() as temp:
            repo=Path(temp); path=repo/"src"/"ofx-import-parser.ts"; path.parent.mkdir(parents=True)
            path.write_text("export function parseOfx(raw: string) { return raw; }\n",encoding="utf-8")
            report=detect(repo,["src/ofx-import-parser.ts"]); self.assertTrue(report["flags"]["input_parser"]); self.assertTrue(report["high_confidence"]["input_parser"])

    def test_detector_marks_generic_parser_code_as_high_risk(self):
        with tempfile.TemporaryDirectory() as temp:
            repo=Path(temp); path=repo/"src"/"import-service.ts"; path.parent.mkdir(parents=True)
            path.write_text("export function parseDocument(raw: string) { return decodeXml(raw); }\n",encoding="utf-8")
            report=detect(repo,["src/import-service.ts"]); self.assertTrue(report["flags"]["input_parser"]); self.assertTrue(report["high_confidence"]["input_parser"])

    def complete_risk(self):
        modes=["xml-declared","xml-without-declaration"]; invariants=["direct-child-record","direct-child-field"]; fields=["amount","name"]; placements=["direct","generic-container","scalar-container"]
        return {"input_parser":True,"input_parser_contract":{
            "accepted_modes":modes,"structural_invariants":invariants,
            "mode_invariant_matrix":[{"mode":m,"invariant":i,"required":True} for m in modes for i in invariants],
            "consumed_fields":fields,"field_scope_placements":placements,
            "mode_field_scope_matrix":[{"mode":m,"field":f,"placement":p,"required":True} for m in modes for f in fields for p in placements],
            "raw_boundary_stages":["transport","body-parser","field-extraction","parser","persistence"],
            "raw_boundary_cases":["missing","empty","whitespace-only","exact-limit","limit-plus-one","valid-plus-external-padding-over-limit","over-limit-before-transformation","representation-changing-transform","invalid-encoding-or-header"],
            "error_precedence_cases":["missing-before-empty","size-before-structure"],"control_ids":CONTROL_IDS,"hierarchical":True}}

    def complete_scenario(self):
        c=self.complete_risk()["input_parser_contract"]
        return {"id":"SC-F34","family_id":"F34",
            "mode_invariant_pairs":[f"{x['mode']}::{x['invariant']}" for x in c["mode_invariant_matrix"]],
            "mode_field_scope_cases":[f"{x['mode']}::{x['field']}::{x['placement']}" for x in c["mode_field_scope_matrix"]],
            "boundary_stages":c["raw_boundary_stages"],"boundary_cases":c["raw_boundary_cases"],"error_precedence_cases":c["error_precedence_cases"],"control_ids":CONTROL_IDS,
            "checks":["parser-direct-call","public-boundary-call","raw-input-preserved","missing-empty-distinguished","whitespace-only-domain-error","exact-size-boundary","limit-plus-one-rejected","valid-plus-external-padding-rejected","over-limit-before-transformation","error-code-precedence","identity-or-hash-representation-verified","all-consumed-fields-covered","no-side-effects-on-rejection","direct-scope-membership","scalar-as-container","unknown-wrapper","inactive-content","cross-scope-metadata","duplicate-or-reordered-sections","mode-without-declaration-or-equivalent"],
            "evidence":["EV-BOUNDARY","EV-NEGATIVE"]}

    def validate(self,risk,scenario=None):
        errors=[]; validate_input_parser_contract(risk,[scenario or self.complete_scenario()],{"EV-BOUNDARY":{"type":"boundary-call"},"EV-NEGATIVE":{"type":"negative-control"}},errors); return errors

    def test_input_parser_requires_f34(self): self.assertIn("F34",required_families({"input_parser":True}))
    def test_rejects_missing_mode_field_cell(self):
        risk=self.complete_risk(); risk["input_parser_contract"]["mode_field_scope_matrix"].pop(); self.assertTrue(any("mode_field_scope_matrix is incomplete" in e for e in self.validate(risk)))
    def test_rejects_missing_padding_and_limit_plus_one(self):
        risk=self.complete_risk(); risk["input_parser_contract"]["raw_boundary_cases"]=[x for x in risk["input_parser_contract"]["raw_boundary_cases"] if x not in {"limit-plus-one","valid-plus-external-padding-over-limit"}]; self.assertTrue(any("raw_boundary_cases misses" in e for e in self.validate(risk)))
    def test_rejects_missing_stable_control(self):
        risk=self.complete_risk(); risk["input_parser_contract"]["control_ids"].remove("IP-SCOPE-001"); self.assertTrue(any("control_ids misses" in e for e in self.validate(risk)))
    def test_accepts_complete_contract(self): self.assertEqual(self.validate(self.complete_risk()),[])

    def test_high_confidence_parser_cannot_be_silently_disabled(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); packet=base/"packet"; packet.mkdir(); detection={"flags":{"input_parser":True,"multiple_entrypoints":[]},"high_confidence":{"input_parser":True}}; dp=packet/"risk_detection.json"; dp.write_text(json.dumps(detection),encoding="utf-8")
            bools=("multi_entity","multi_step","persistence","durable_persistence_required","authorization","privacy","visual","data_migration","fallback_paths","documentation_impact","read_model_closure","canonical_source_consistency","documentation_contract_transition","runtime_policy","adapter_contract","request_translation","legacy_compatibility","documentation_claims","audit_packet_published","input_parser")
            profile={k:False for k in bools}; profile.update({"multiple_entrypoints":[],"persistence_boundaries":[],"external_dependencies":[],"eligibility_sources":[],"transactional_authorization_operations":[],"execution_state_boundaries":[],"control_propagation_paths":[],"capability_operation_mappings":[],"request_translation_mappings":[],"legacy_compatibility_matrix":[],"documentation_claim_inventory":[]})
            errors=[]; validate_risk({"repository_path":str(base),"risk_detection":{"path":str(dp),"sha256":hashlib.sha256(dp.read_bytes()).hexdigest()},"risk_overrides":[],"risk_profile":profile},packet,base,errors); self.assertTrue(any("understates high-confidence detection: input_parser" in e for e in errors),errors)

if __name__=="__main__": unittest.main()
