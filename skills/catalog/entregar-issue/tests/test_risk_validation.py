from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.risk_validation import validate_risk
from orchestrator_gate.evidence_validation import required_families


class RiskValidationTests(unittest.TestCase):
    def test_high_risk_profiles_require_critical_inventories_and_families(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            packet = base / "packet"
            packet.mkdir()
            detection_path = packet / "risk_detection.json"
            detection_path.write_text(
                json.dumps({"flags": {}, "high_confidence": {}}),
                encoding="utf-8",
            )
            data = {
                "repository_path": str(base),
                "risk_detection": {
                    "path": str(detection_path),
                    "sha256": hashlib.sha256(detection_path.read_bytes()).hexdigest(),
                },
                "risk_overrides": [],
                "risk_profile": {
                    "multi_entity": True, "multi_step": True, "persistence": True,
                    "durable_persistence_required": False,
                    "authorization": True, "privacy": True, "visual": True,
                    "data_migration": True, "fallback_paths": False,
                    "documentation_impact": True, "read_model_closure": True,
                    "canonical_source_consistency": True, "documentation_contract_transition": True,
                    "runtime_policy": False, "adapter_contract": False, "request_translation": False,
                    "legacy_compatibility": False, "documentation_claims": False,
                    "audit_packet_published": False, "input_parser": False,
                    "multiple_entrypoints": [], "persistence_boundaries": [],
                    "external_dependencies": [], "eligibility_sources": [],
                    "transactional_authorization_operations": [],
                    "public_boundaries": [], "transactional_business_operations": [],
                    "structural_invariants": [], "freshness_sources": [],
                    "stateful_ui_transitions": [],
                    "execution_state_boundaries": [], "control_propagation_paths": [],
                    "capability_operation_mappings": [], "request_translation_mappings": [],
                    "legacy_compatibility_matrix": [], "documentation_claim_inventory": [],
                    "visual_contract": {},
                },
            }
            errors: list[str] = []
            risk = validate_risk(data, packet, base, errors)
            for inventory in (
                "public_boundaries", "transactional_business_operations",
                "structural_invariants", "freshness_sources",
                "stateful_ui_transitions",
            ):
                self.assertTrue(any(inventory in error for error in errors), inventory)
            self.assertTrue(
                {"F20", "F21", "F22", "F23", "F24", "F25", "F26", "F27"}.issubset(required_families(risk))
            )

    def test_high_confidence_risk_cannot_be_silently_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            packet = base / "packet"
            packet.mkdir()
            detection = {
                "schema_version": 1,
                "flags": {"visual": True, "documentation_impact": True, "multiple_entrypoints": []},
                "high_confidence": {"visual": True, "documentation_impact": False},
            }
            path = packet / "risk_detection.json"
            path.write_text(json.dumps(detection), encoding="utf-8")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            data = {
                "risk_detection": {"path": str(path), "sha256": digest},
                "risk_overrides": [],
                "risk_profile": {
                    "multi_entity": False, "multi_step": False, "persistence": False,
                    "durable_persistence_required": False, "authorization": False, "privacy": False,
                    "visual": False, "data_migration": False, "fallback_paths": False,
                    "documentation_impact": True, "read_model_closure": False,
                    "canonical_source_consistency": False, "documentation_contract_transition": False,
                    "runtime_policy": False, "adapter_contract": False, "request_translation": False,
                    "legacy_compatibility": False, "documentation_claims": False,
                    "audit_packet_published": False, "input_parser": False,
                    "multiple_entrypoints": [], "persistence_boundaries": [], "external_dependencies": [],
                    "eligibility_sources": [], "transactional_authorization_operations": [],
                    "execution_state_boundaries": [], "control_propagation_paths": [],
                    "capability_operation_mappings": [], "request_translation_mappings": [],
                    "legacy_compatibility_matrix": [], "documentation_claim_inventory": [],
                },
            }
            errors = []
            validate_risk(data, packet, base, errors)
            self.assertTrue(any("visual" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
