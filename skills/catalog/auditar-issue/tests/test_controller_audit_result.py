from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "validate_controller_audit_result.py"
HASH = "a" * 64
IDENTITY = {
    "repository": "owner/repo", "issue": 1, "pull_request": None, "branch": "issue-1",
    "head_sha": "1" * 40, "base_sha": "2" * 40, "merge_preview_sha": None,
    "issue_snapshot_sha256": HASH, "diff_sha256": HASH, "skills_sha256": HASH,
    "captured_at": "2026-07-28T10:00:00Z",
}


class ControllerAuditResultTests(unittest.TestCase):
    def valid_report(self):
        return {
            "schema_version": 3,
            "mode": "controller-adversarial",
            "approval_scope": "internal-only",
            "release_gate_satisfied": False,
            "verdict": "Aprovado",
            "identity": IDENTITY,
            "started_at": "2026-07-28T10:01:00Z",
            "finished_at": "2026-07-28T10:02:00Z",
            "read_only": True,
            "requirements_rederived": True,
            "modifications_detected": False,
            "source_manifest_sha256": HASH,
            "requirements_rederivation_sha256": HASH,
            "coverage_matrix_sha256": HASH,
            "neutral_packet_sha256": HASH,
            "neutral_packet": {"implementation_conclusions_included": False, "implementation_narrative_included": False, "allowed_contents": ["canonical-sources", "identity", "diff", "source", "tests", "raw-evidence"]},
            "prior_internal_approval": None,
            "audit_escapes": [],
            "requirements": [{
                "id": "REQ-1", "origin": "SRC-1", "statement": "Implement the requested behavior.",
                "status": "Implementado", "evidence": ["positive"],
                "negative_controls": ["negative"],
                "negative_control_evidence": [{
                    "id": "negative",
                    "risk_family": "integration",
                    "dimension": "wrong-source",
                    "failure_mode": "The implementation accepts a value from the wrong source.",
                    "plausible_wrong_implementation": "Read the first available source without applying precedence.",
                    "control_type": "test",
                    "procedure": "python -m unittest test_wrong_source",
                    "expected": "The wrong source is rejected.",
                    "observed": "The wrong source was rejected.",
                    "status": "passed",
                    "evidence_path": "negative-control.json",
                    "evidence_sha256": HASH,
                    "head_sha": IDENTITY["head_sha"],
                    "sibling_cases": ["missing preferred source"],
                }],
                "regression_evidence": ["regression"],
                "scope_basis": None,
            }],
            "findings": [],
            "gates": [{"name": "tests", "status": "passed", "attestation_sha256": HASH}],
            "limitations": [],
        }

    def run_report(self, report, *, materialize_evidence=True):
        with tempfile.TemporaryDirectory() as temp:
            payload = deepcopy(report)
            root = Path(temp)
            if materialize_evidence:
                for requirement in payload.get("requirements", []):
                    for control in requirement.get("negative_control_evidence", []):
                        evidence = root / control["evidence_path"]
                        evidence.parent.mkdir(parents=True, exist_ok=True)
                        evidence.write_text(json.dumps({"control": control["id"], "observed": control["observed"]}), encoding="utf-8")
                        control["evidence_sha256"] = hashlib.sha256(evidence.read_bytes()).hexdigest()
            path = root / "report.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True)

    def test_accepts_complete_approved_report(self):
        self.assertEqual(self.run_report(self.valid_report()).returncode, 0)

    def test_rejects_approval_with_open_blocking_finding(self):
        report = self.valid_report()
        report["findings"] = [{
            "id": "F-1", "fingerprint": "bug", "severity": "Alto", "status": "open",
            "disposition": "blocking", "requirement_id": "REQ-1", "impact": "Breaks behavior",
            "evidence": ["reproduction"], "escape_category": "other", "sibling_cases": [],
        }]
        self.assertNotEqual(self.run_report(report).returncode, 0)

    def test_rejects_implemented_requirement_without_negative_control(self):
        report = self.valid_report()
        report["requirements"][0]["negative_controls"] = []
        self.assertNotEqual(self.run_report(report).returncode, 0)

    def test_rejects_negative_control_without_structured_evidence(self):
        report = self.valid_report()
        report["requirements"][0]["negative_control_evidence"] = []
        self.assertNotEqual(self.run_report(report).returncode, 0)

    def test_rejects_negative_control_id_mismatch(self):
        report = self.valid_report()
        report["requirements"][0]["negative_control_evidence"][0]["id"] = "other-control"
        self.assertNotEqual(self.run_report(report).returncode, 0)

    def test_rejects_missing_negative_control_artifact(self):
        report = self.valid_report()
        self.assertNotEqual(self.run_report(report, materialize_evidence=False).returncode, 0)

    def test_rejects_failed_negative_control(self):
        report = self.valid_report()
        report["requirements"][0]["negative_control_evidence"][0]["status"] = "failed"
        self.assertNotEqual(self.run_report(report).returncode, 0)

    def test_rejects_internal_mode_claiming_release_scope(self):
        report = self.valid_report()
        report["approval_scope"] = "independent-release-gate"
        self.assertNotEqual(self.run_report(report).returncode, 0)

    def test_rejects_contaminated_neutral_packet(self):
        report = self.valid_report()
        report["neutral_packet"]["implementation_conclusions_included"] = True
        self.assertNotEqual(self.run_report(report).returncode, 0)

    def test_independent_finding_after_internal_approval_requires_escape(self):
        report = self.valid_report()
        report["mode"] = "independent"
        report["approval_scope"] = "independent-release-gate"
        report["release_gate_satisfied"] = True
        report["verdict"] = "Reprovado"
        report["prior_internal_approval"] = {
            "head_sha": IDENTITY["head_sha"], "report_sha256": HASH,
            "assurance_level": "controller-adversarial",
            "approved_at": "2026-07-28T09:59:00Z",
        }
        report["findings"] = [{
            "id": "F-ESC", "fingerprint": "retry-gap", "severity": "Alto",
            "status": "open", "disposition": "blocking", "requirement_id": "REQ-1",
            "impact": "Breaks recoverable retry", "evidence": ["reproduction"],
            "escape_category": "execution-state-gap", "sibling_cases": [],
        }]
        self.assertNotEqual(self.run_report(report).returncode, 0)
        report["audit_escapes"] = [{
            "finding_id": "F-ESC", "fingerprint": "retry-gap",
            "affected_head_sha": IDENTITY["head_sha"],
            "prior_internal_report_sha256": HASH,
            "detected_at": "2026-07-28T10:02:00Z",
        }]
        self.assertEqual(self.run_report(report).returncode, 0)


    def add_input_parser_controls(self, report, dimensions):
        stable_ids = {
            "raw-boundary-preservation": "IP-RAW-001",
            "syntax-mode-invariant-matrix": "IP-MODE-001",
            "scope-membership": "IP-SCOPE-001",
            "inactive-content": "IP-INACTIVE-001",
            "validation-order-error-precedence": "IP-EFFECT-001",
        }
        controls = []
        for index, dimension in enumerate(dimensions, start=1):
            controls.append({
                "id": stable_ids.get(dimension, f"parser-{index}"),
                "risk_family": "input-parser",
                "dimension": dimension,
                "failure_mode": f"The parser accepts an invalid {dimension} case.",
                "plausible_wrong_implementation": f"Validate only the happy path for {dimension}.",
                "control_type": "test",
                "procedure": f"python -m unittest parser_{index}",
                "expected": "The malformed or ambiguous input is rejected without effects.",
                "observed": "The malformed or ambiguous input was rejected without effects.",
                "status": "passed",
                "evidence_path": f"parser-{index}.json",
                "evidence_sha256": HASH,
                "head_sha": IDENTITY["head_sha"],
                "sibling_cases": [f"alternate {dimension}", f"second mode for {dimension}"],
            })
        requirement = report["requirements"][0]
        requirement["negative_controls"] = [item["id"] for item in controls]
        requirement["negative_control_evidence"] = controls

    def test_rejects_input_parser_without_mandatory_dimensions(self):
        report = self.valid_report()
        self.add_input_parser_controls(report, ["scope-membership"])
        result = self.run_report(report)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mandatory dimensions", result.stderr)

    def test_accepts_input_parser_with_mandatory_dimensions_and_siblings(self):
        report = self.valid_report()
        self.add_input_parser_controls(report, [
            "raw-boundary-preservation",
            "validation-order-error-precedence",
            "syntax-mode-invariant-matrix",
            "scope-membership",
            "inactive-content",
        ])
        self.assertEqual(self.run_report(report).returncode, 0)

    def test_rejects_input_parser_without_stable_control_ids(self):
        report = self.valid_report()
        self.add_input_parser_controls(report, [
            "raw-boundary-preservation",
            "validation-order-error-precedence",
            "syntax-mode-invariant-matrix",
            "scope-membership",
        ])
        result = self.run_report(report)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stable control ids", result.stderr)

    def test_rejects_non_read_only_report(self):
        report = self.valid_report()
        report["read_only"] = False
        self.assertNotEqual(self.run_report(report).returncode, 0)


if __name__ == "__main__":
    unittest.main()
