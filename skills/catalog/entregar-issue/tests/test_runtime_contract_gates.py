from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from orchestrator_gate.evidence_validation import required_families
from orchestrator_gate.risk_detection import detect
from orchestrator_gate.risk_validation import validate_risk


class RuntimeContractGateTests(unittest.TestCase):
    def test_runtime_contract_escape_signals_are_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            report = detect(
                repo,
                [],
                """
                capability registry support matrix provider adapter operations
                resolver executor ready degraded disabled invalid retry fallback timeout AbortSignal
                translate tools web_search responseJsonSchema multimodal embeddings transcription
                preserve legacy consumer with no observable change
                documentation guarantees support and rejects unsupported requests before any network call
                """,
            )
            for flag in (
                "runtime_policy", "adapter_contract", "request_translation",
                "legacy_compatibility", "documentation_claims",
            ):
                self.assertTrue(report["flags"][flag], flag)

    def test_provider_fallback_requires_runtime_gates_not_persistence_gate(self) -> None:
        risk = {
            "multi_entity": False, "multi_step": False, "persistence": False,
            "durable_persistence_required": False, "authorization": False,
            "privacy": False, "visual": False, "data_migration": False,
            "fallback_paths": True, "documentation_impact": True,
            "read_model_closure": False, "canonical_source_consistency": False,
            "documentation_contract_transition": False,
            "runtime_policy": True, "adapter_contract": True,
            "request_translation": True, "legacy_compatibility": True,
            "documentation_claims": True,
        }
        families = required_families(risk)
        self.assertNotIn("F19", families)
        self.assertTrue({"F28", "F29", "F30", "F31", "F32", "F33"}.issubset(families))

    def test_runtime_contract_flags_require_structured_inventories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            packet = base / "packet"
            packet.mkdir()
            detection_path = packet / "risk_detection.json"
            detection_path.write_text(json.dumps({"flags": {}, "high_confidence": {}}), encoding="utf-8")
            data = {
                "repository_path": str(base),
                "risk_detection": {
                    "path": str(detection_path),
                    "sha256": hashlib.sha256(detection_path.read_bytes()).hexdigest(),
                },
                "risk_overrides": [],
                "risk_profile": {
                    "multi_entity": False, "multi_step": False, "persistence": False,
                    "durable_persistence_required": False, "authorization": False,
                    "privacy": False, "visual": False, "data_migration": False,
                    "fallback_paths": True, "documentation_impact": True,
                    "read_model_closure": False, "canonical_source_consistency": False,
                    "documentation_contract_transition": False,
                    "runtime_policy": True, "adapter_contract": True,
                    "request_translation": True, "legacy_compatibility": True,
                    "documentation_claims": True, "audit_packet_published": False,
                    "multiple_entrypoints": [], "persistence_boundaries": [],
                    "external_dependencies": ["AI provider"],
                    "eligibility_sources": [], "transactional_authorization_operations": [],
                    "public_boundaries": [], "transactional_business_operations": [],
                    "structural_invariants": [], "freshness_sources": [],
                    "stateful_ui_transitions": [], "visual_contract": {},
                    "execution_state_boundaries": [], "control_propagation_paths": [],
                    "capability_operation_mappings": [], "request_translation_mappings": [],
                    "legacy_compatibility_matrix": [], "documentation_claim_inventory": [],
                },
            }
            errors: list[str] = []
            validate_risk(data, packet, base, errors)
            for inventory in (
                "execution_state_boundaries", "control_propagation_paths",
                "capability_operation_mappings", "request_translation_mappings",
                "legacy_compatibility_matrix", "documentation_claim_inventory",
            ):
                self.assertTrue(any(inventory in error for error in errors), (inventory, errors))


if __name__ == "__main__":
    unittest.main()
