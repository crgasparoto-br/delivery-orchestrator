#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "evaluate_cycle.py"
SPEC = importlib.util.spec_from_file_location("evaluate_cycle", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
HEAD = "1" * 40
OLD_HEAD = "9" * 40


class EvaluateCycleV5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.identity = {
            "repository": "owner/repo",
            "issue": 541,
            "pull_request": None,
            "branch": "issue-541",
            "head_sha": HEAD,
            "base_sha": "2" * 40,
            "merge_preview_sha": None,
            "issue_snapshot_sha256": HASH_A,
            "diff_sha256": HASH_B,
            "skills_sha256": HASH_C,
            "captured_at": "2026-07-27T20:00:00Z",
        }
        self.state_path = self.root / "state.json"
        self.state = self.build_valid_state()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_json(self, name: str, payload: dict) -> tuple[str, str]:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
        return name, hashlib.sha256(path.read_bytes()).hexdigest()

    def write_text(self, name: str, value: str) -> tuple[str, str]:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
        return name, hashlib.sha256(path.read_bytes()).hexdigest()

    def artifact(self, name: str, path: str, digest: str) -> dict:
        return {
            "name": name,
            "required": True,
            "status": "present",
            "path": path,
            "sha256": digest,
            "head_sha": HEAD,
        }

    def build_valid_state(self) -> dict:
        control_path, control_hash = self.write_json("negative-control.json", {
            "scenario": "wrong source is rejected",
            "expected": "rejected",
            "observed": "rejected",
        })
        negative_control = {
            "id": "tests:wrong-source-rejected",
            "risk_family": "documentation",
            "dimension": "source-precedence",
            "failure_mode": "A lower-precedence source silently overrides the canonical source.",
            "plausible_wrong_implementation": "Use the first available source without applying documented precedence.",
            "control_type": "test",
            "procedure": "python -m unittest test_wrong_source_rejected",
            "expected": "The lower-precedence source is rejected.",
            "observed": "The lower-precedence source was rejected.",
            "status": "passed",
            "evidence_path": control_path,
            "evidence_sha256": control_hash,
            "head_sha": HEAD,
            "sibling_cases": ["missing canonical source"],
        }
        requirement = {
            "id": "REQ-001",
            "origin": "SRC-ISSUE",
            "statement": "Preserve the documented behavior while applying the requested change.",
            "status": "Implementado",
            "evidence": ["tests:positive"],
            "negative_controls": [negative_control["id"]],
            "negative_control_evidence": [negative_control],
            "regression_evidence": ["tests:legacy-flow"],
            "scope_basis": None,
        }
        source_path, source_hash = self.write_json("source-manifest.json", {
            "schema_version": 1,
            "complete": True,
            "sources": [{"id": "SRC-ISSUE", "kind": "issue", "locator": "owner/repo#541", "sha256": HASH_A}],
            "discovery": {
                "commands": ["find . -name AGENTS.md -o -name README.md"],
                "roots": ["."],
                "discovered_paths": ["README.md"],
                "declared_paths": ["README.md"],
                "omitted_sources": [],
                "state_transition": False,
                "stale_claim_queries": [],
                "unresolved_stale_claims": [],
            },
        })
        rederive_path, rederive_hash = self.write_json("requirements-rederivation.json", {
            "schema_version": 1,
            "complete": True,
            "source_manifest_sha256": source_hash,
            "requirements": [{"id": requirement["id"], "origin": requirement["origin"], "statement": requirement["statement"]}],
        })
        coverage_path, coverage_hash = self.write_json("coverage-matrix.json", {
            "schema_version": 1,
            "complete": True,
            "requirements": [{
                "requirement_id": requirement["id"],
                "positive_evidence": requirement["evidence"],
                "negative_controls": requirement["negative_controls"],
                "negative_control_evidence": requirement["negative_control_evidence"],
                "regression_evidence": requirement["regression_evidence"],
            }],
        })
        risk_families = [{
            "name": "documentation",
            "applicable": True,
            "basis": "README.md changed and documentation governance is mandatory.",
            "required_gates": ["tests"],
            "required_subskills": ["documentacao-repositorio"],
        }]
        changed_files = [{"path": "README.md", "families": ["documentation"]}]
        applicability_path, applicability_hash = self.write_json("applicability-ledger.json", {
            "schema_version": 1,
            "complete": True,
            "changed_files": changed_files,
            "risk_families": risk_families,
        })

        stdout_hash = hashlib.sha256(b"ok\n").hexdigest()
        stderr_hash = hashlib.sha256(b"").hexdigest()
        attestation = {
            "schema_version": 1,
            "name": "tests",
            "command": "python -m unittest",
            "cwd": "/repo",
            "exit_code": 0,
            "started_at": "2026-07-27T20:01:10Z",
            "finished_at": "2026-07-27T20:01:20Z",
            "head_sha": HEAD,
            "stdout_sha256": stdout_hash,
            "stderr_sha256": stderr_hash,
        }
        attestation_path, attestation_hash = self.write_json("gate-tests.json", attestation)
        gate = {
            "name": "tests",
            "required": True,
            "status": "passed",
            "command": attestation["command"],
            "cwd": attestation["cwd"],
            "exit_code": 0,
            "started_at": attestation["started_at"],
            "finished_at": attestation["finished_at"],
            "attestation_path": attestation_path,
            "attestation_sha256": attestation_hash,
            "stdout_sha256": stdout_hash,
            "stderr_sha256": stderr_hash,
            "head_sha": HEAD,
        }
        gate_report_path, gate_report_hash = self.write_json("gate-report.json", {
            "schema_version": 1,
            "complete": True,
            "gates": [{"name": "tests", "status": "passed", "attestation_sha256": attestation_hash}],
        })
        history_path, history_hash = self.write_json("cycle-history.json", {
            "schema_version": 1,
            "append_only": True,
            "cycles": [{"cycle": 2, "finding_fingerprints": []}],
        })
        subskill_path, subskill_hash = self.write_json("documentacao-result.json", {
            "schema_version": 1,
            "skill": "documentacao-repositorio",
            "status": "passed",
            "findings": [],
        })

        generic_artifacts = {}
        for name in (
            "execution-context", "specification-snapshot", "requirement-closure",
            "risk-profile", "documentation-impact",
        ):
            generic_artifacts[name] = self.write_json(f"{name}.json", {
                "schema_version": 1,
                "head_sha": HEAD,
                "complete": True,
            })

        report_payload = {
            "schema_version": 3,
            "mode": "controller-adversarial",
            "approval_scope": "internal-only",
            "verdict": "Aprovado",
            "identity": self.identity,
            "started_at": "2026-07-27T20:01:00Z",
            "finished_at": "2026-07-27T20:02:00Z",
            "read_only": True,
            "requirements_rederived": True,
            "modifications_detected": False,
            "source_manifest_sha256": source_hash,
            "requirements_rederivation_sha256": rederive_hash,
            "coverage_matrix_sha256": coverage_hash,
            "neutral_packet_sha256": HASH_A,
            "neutral_packet": {"implementation_conclusions_included": False, "implementation_narrative_included": False, "allowed_contents": ["canonical-sources", "identity", "diff", "source", "tests", "raw-evidence"]},
            "prior_internal_approval": None,
            "audit_escapes": [],
            "requirements": [deepcopy(requirement)],
            "findings": [],
            "gates": [{"name": "tests", "status": "passed", "attestation_sha256": attestation_hash}],
            "limitations": [],
        }
        report_path, report_hash = self.write_json("controller-audit-report.json", report_payload)

        artifacts = [
            self.artifact("source-manifest", source_path, source_hash),
            self.artifact("requirements-rederivation", rederive_path, rederive_hash),
            self.artifact("coverage-matrix", coverage_path, coverage_hash),
            self.artifact("applicability-ledger", applicability_path, applicability_hash),
            self.artifact("gate-report", gate_report_path, gate_report_hash),
            self.artifact("cycle-history", history_path, history_hash),
            self.artifact("controller-audit-report", report_path, report_hash),
        ]
        for name, (path, digest) in generic_artifacts.items():
            artifacts.append(self.artifact(name, path, digest))

        return {
            "schema_version": 5,
            "issue": 541,
            "cycle": 2,
            "state": "auditing",
            "single_invocation_mode": True,
            "controller_mode": "delivery-single-invocation",
            "execution_mode": "standard",
            "frozen_identity": self.identity,
            "current_identity": deepcopy(self.identity),
            "audit": {
                "validity": "controller-adversarial",
                "verdict": "Aprovado",
                "identity": deepcopy(self.identity),
                "implementation_context_id": "impl-context-001",
                "audit_context_id": "audit-context-001",
                "started_at": "2026-07-27T20:01:00Z",
                "finished_at": "2026-07-27T20:02:00Z",
                "read_only": True,
                "requirements_rederived": True,
                "neutral_packet_sha256": HASH_A,
                "implementation_conclusions_included": False,
                "implementation_narrative_included": False,
                "report_path": report_path,
                "report_sha256": report_hash,
                "requirements_rederivation_path": rederive_path,
                "requirements_rederivation_sha256": rederive_hash,
                "coverage_matrix_path": coverage_path,
                "coverage_matrix_sha256": coverage_hash,
                "source_manifest_path": source_path,
                "source_manifest_sha256": source_hash,
                "modifications_detected": False,
                "isolation_proven": False,
                "external_context_proven": False,
                "signature_required": False,
                "signature_valid": None,
            },
            "requirements_inventory_complete": True,
            "requirements": [requirement],
            "gate_inventory_complete": True,
            "gates": [gate],
            "findings": [],
            "regressions": [],
            "limitations": [],
            "artifacts": artifacts,
            "risk_families": risk_families,
            "subskill_results": [{
                "skill": "documentacao-repositorio",
                "status": "passed",
                "artifact_path": subskill_path,
                "artifact_sha256": subskill_hash,
            }],
            "changed_files": changed_files,
            "skill_changes": [],
            "operational_amendments": [],
            "prior_internal_approval": None,
            "audit_escapes": [],
            "adversarial_controls": [],
            "learning_review": {
                "required": False,
                "completed": True,
                "reviewed_finding_ids": [],
                "items": [],
                "ledger_path": None,
                "ledger_sha256": None,
            },
            "blocked": {"active": False, "external": False, "alternatives_exhausted": False, "reason": None},
        }

    def rewrite_artifact(self, state: dict, name: str, payload: dict) -> None:
        path, digest = self.write_json(f"{name}.json", payload)
        artifact = next(item for item in state["artifacts"] if item["name"] == name)
        artifact.update({"path": path, "sha256": digest})
        mapping = {
            "controller-audit-report": ("report_path", "report_sha256"),
            "source-manifest": ("source_manifest_path", "source_manifest_sha256"),
            "requirements-rederivation": ("requirements_rederivation_path", "requirements_rederivation_sha256"),
            "coverage-matrix": ("coverage_matrix_path", "coverage_matrix_sha256"),
        }
        if name in mapping:
            path_key, hash_key = mapping[name]
            state["audit"][path_key] = path
            state["audit"][hash_key] = digest

    def audit_report(self, state: dict) -> dict:
        path = self.root / state["audit"]["report_path"]
        return json.loads(path.read_text())

    def sync_audit_report(self, state: dict, mutate=None) -> None:
        report = self.audit_report(state)
        report["mode"] = state["audit"]["validity"]
        report["approval_scope"] = "independent-release-gate" if state["audit"]["validity"] == "independent" else "internal-only"
        report["verdict"] = state["audit"]["verdict"]
        report["identity"] = state["audit"]["identity"]
        report["read_only"] = state["audit"]["read_only"]
        report["requirements_rederived"] = state["audit"]["requirements_rederived"]
        report["modifications_detected"] = state["audit"]["modifications_detected"]
        report["source_manifest_sha256"] = state["audit"]["source_manifest_sha256"]
        report["requirements_rederivation_sha256"] = state["audit"]["requirements_rederivation_sha256"]
        report["coverage_matrix_sha256"] = state["audit"]["coverage_matrix_sha256"]
        report["neutral_packet_sha256"] = state["audit"]["neutral_packet_sha256"]
        report["neutral_packet"] = {
            "implementation_conclusions_included": state["audit"]["implementation_conclusions_included"],
            "implementation_narrative_included": state["audit"]["implementation_narrative_included"],
            "allowed_contents": ["canonical-sources", "identity", "diff", "source", "tests", "raw-evidence"],
        }
        report["prior_internal_approval"] = deepcopy(state["prior_internal_approval"])
        report["audit_escapes"] = [{
            "finding_id": item["finding_id"], "fingerprint": item["fingerprint"],
            "affected_head_sha": item["affected_head_sha"],
            "prior_internal_report_sha256": item["prior_internal_report_sha256"],
            "detected_at": item["detected_at"],
        } for item in state["audit_escapes"]]
        report["requirements"] = [deepcopy(item) for item in state["requirements"]]
        report["findings"] = []
        for item in state["findings"]:
            report["findings"].append({
                "id": item["id"],
                "fingerprint": item["fingerprint"],
                "severity": item["severity"],
                "status": item["status"],
                "disposition": item["disposition"],
                "requirement_id": item.get("requirement_id"),
                "impact": "Verified impact for regression coverage.",
                "evidence": ["audit reproduction"],
            })
        if mutate:
            mutate(report)
        self.rewrite_artifact(state, "controller-audit-report", report)

    def evaluate(self, state=None):
        payload = deepcopy(state or self.state)
        self.state_path.write_text(json.dumps(payload), encoding="utf-8")
        MODULE.validate_state(payload)
        return MODULE.evaluate(self.state_path, payload)

    def add_input_parser_contract(
        self,
        *,
        changed_path: str = "src/statement-parser.ts",
        hierarchical: bool = False,
        include_matrix: bool = True,
        omit_control: str | None = None,
        omit_matrix_cell: bool = False,
        raw_cases: list[str] | None = None,
    ) -> None:
        requirement = self.state["requirements"][0]
        control_specs = [
            ("IP-RAW-001", "raw-boundary-preservation"),
            ("IP-MODE-001", "syntax-mode-invariant-matrix"),
            ("IP-SCOPE-001", "scope-membership"),
            ("IP-INACTIVE-001", "inactive-content"),
            ("IP-EFFECT-001", "validation-order-error-precedence"),
        ]
        controls = []
        for control_id, dimension in control_specs:
            if control_id == omit_control:
                continue
            evidence_path, evidence_hash = self.write_json(
                f"{control_id.lower()}.json",
                {"control_id": control_id, "dimension": dimension, "result": "passed"},
            )
            controls.append({
                "id": control_id,
                "risk_family": "input-parser",
                "dimension": dimension,
                "failure_mode": f"Parser accepts a plausible wrong implementation for {dimension}.",
                "plausible_wrong_implementation": f"Validate only the happy path and omit {dimension}.",
                "control_type": "test",
                "procedure": f"python -m unittest {control_id.lower().replace('-', '_')}",
                "expected": "The discriminant input is rejected or normalized exactly as contracted without side effects.",
                "observed": "The discriminant input matched the contract and produced no forbidden side effects.",
                "status": "passed",
                "evidence_path": evidence_path,
                "evidence_sha256": evidence_hash,
                "head_sha": HEAD,
                "sibling_cases": [f"alternate {dimension} case", f"second {dimension} mode"],
            })
        requirement["negative_controls"] = [item["id"] for item in controls]
        requirement["negative_control_evidence"] = controls
        coverage = json.loads((self.root / "coverage-matrix.json").read_text())
        coverage["requirements"][0]["negative_controls"] = requirement["negative_controls"]
        coverage["requirements"][0]["negative_control_evidence"] = controls
        self.rewrite_artifact(self.state, "coverage-matrix", coverage)

        self.state["risk_families"].append({
            "name": "input-parser",
            "applicable": True,
            "basis": "Untrusted structured input parser changed.",
            "required_gates": ["tests"],
            "required_subskills": [],
        })
        self.state["changed_files"].append({"path": changed_path, "families": ["input-parser"]})
        applicability = {
            "schema_version": 1,
            "complete": True,
            "changed_files": self.state["changed_files"],
            "risk_families": self.state["risk_families"],
        }
        self.rewrite_artifact(self.state, "applicability-ledger", applicability)

        if include_matrix:
            modes = ["strict-xml", "xml-without-declaration", "sgml"] if hierarchical else ["default"]
            consumed_fields = ["DTPOSTED", "TRNAMT"] if hierarchical else ["record"]
            placements = ["direct", "generic-container", "scalar-container"] if hierarchical else ["direct"]
            rows = [
                {
                    "mode": mode,
                    "field": field,
                    "placement": placement,
                    "required": True,
                    "evidence_ids": ["IP-SCOPE-001"],
                }
                for mode in modes
                for field in consumed_fields
                for placement in placements
            ]
            if omit_matrix_cell:
                rows.pop()
            matrix = {
                "schema_version": 1,
                "head_sha": HEAD,
                "hierarchical": hierarchical,
                "accepted_modes": modes,
                "consumed_fields": consumed_fields,
                "field_scope_placements": placements,
                "mode_field_scope_matrix": rows,
                "raw_boundary_cases": raw_cases or [
                    "empty",
                    "whitespace-only",
                    "limit-minus-one",
                    "limit-exact",
                    "limit-plus-one",
                    "valid-plus-external-padding-over-limit",
                    "invalid-encoding",
                    "bom",
                    "truncated",
                ],
                "error_precedence_cases": ["missing-before-empty", "size-before-structure"],
                "control_ids": [item["id"] for item in controls],
            }
            matrix_path, matrix_hash = self.write_json("input-parser-attack-matrix.json", matrix)
            self.state["artifacts"].append(
                self.artifact("input-parser-attack-matrix", matrix_path, matrix_hash)
            )
        self.sync_audit_report(self.state)

    def test_controller_audit_only_internally_approves(self):
        result = self.evaluate()
        self.assertEqual(result["decision"], "INTERNALLY_APPROVED")
        self.assertEqual(result["internal_approval_record"]["head_sha"], HEAD)
        self.assertEqual(result["internal_approval_record"]["assurance_level"], "controller-adversarial")

    def test_independent_audit_is_required_for_operational_approval(self):
        self.state["audit"]["validity"] = "independent"
        self.state["audit"]["external_context_proven"] = True
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "APPROVED")

    def test_contaminated_neutral_packet_blocks_internal_approval(self):
        self.state["audit"]["implementation_conclusions_included"] = True
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_controller_adversarial_must_be_read_only(self):
        self.state["audit"]["read_only"] = False
        self.sync_audit_report(self.state)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn("not read-only", " ".join(result["checks"]["audit"]["failures"]))

    def test_controller_adversarial_must_rederive_requirements(self):
        self.state["audit"]["requirements_rederived"] = False
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_audit_finish_time_is_required(self):
        self.state["audit"]["finished_at"] = None
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_missing_audit_report_blocks(self):
        (self.root / self.state["audit"]["report_path"]).unlink()
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_requirement_origin_is_mandatory(self):
        self.state["requirements"][0]["origin"] = ""
        with self.assertRaisesRegex(ValueError, "origin is required"):
            self.evaluate()

    def test_requirement_needs_negative_control(self):
        self.state["requirements"][0]["negative_controls"] = []
        coverage = json.loads((self.root / "coverage-matrix.json").read_text())
        coverage["requirements"][0]["negative_controls"] = []
        self.rewrite_artifact(self.state, "coverage-matrix", coverage)
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_negative_control_requires_hashed_evidence_file(self):
        control = self.state["requirements"][0]["negative_control_evidence"][0]
        (self.root / control["evidence_path"]).unlink()
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn("evidence file does not exist", " ".join(result["checks"]["requirements"]["failures"]))

    def test_source_manifest_unresolved_stale_claim_blocks(self):
        manifest = json.loads((self.root / "source-manifest.json").read_text())
        manifest["discovery"]["state_transition"] = True
        manifest["discovery"]["stale_claim_queries"] = ["old capability status"]
        manifest["discovery"]["unresolved_stale_claims"] = ["README.md: capability is still future"]
        self.rewrite_artifact(self.state, "source-manifest", manifest)
        rederive = json.loads((self.root / "requirements-rederivation.json").read_text())
        rederive["source_manifest_sha256"] = self.state["audit"]["source_manifest_sha256"]
        self.rewrite_artifact(self.state, "requirements-rederivation", rederive)
        self.sync_audit_report(self.state)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn("unresolved stale", " ".join(result["checks"]["semantic_artifacts"]["failures"]))

    def test_parser_like_file_requires_input_parser_family(self):
        self.state["changed_files"].append({"path": "src/statement-parser.ts", "families": ["documentation"]})
        applicability = {
            "schema_version": 1, "complete": True,
            "changed_files": self.state["changed_files"], "risk_families": self.state["risk_families"],
        }
        self.rewrite_artifact(self.state, "applicability-ledger", applicability)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn("input-parser risk family", " ".join(result["checks"]["risk_coverage"]["failures"]))

    def test_input_parser_requires_mandatory_adversarial_dimensions(self):
        self.state["risk_families"].append({
            "name": "input-parser", "applicable": True, "basis": "Parser changed",
            "required_gates": ["tests"], "required_subskills": [],
        })
        self.state["changed_files"].append({"path": "src/statement-parser.ts", "families": ["input-parser"]})
        applicability = {
            "schema_version": 1, "complete": True,
            "changed_files": self.state["changed_files"], "risk_families": self.state["risk_families"],
        }
        self.rewrite_artifact(self.state, "applicability-ledger", applicability)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn("mandatory adversarial dimensions", " ".join(result["checks"]["risk_coverage"]["failures"]))

    def test_input_parser_accepts_required_executed_dimensions(self):
        self.add_input_parser_contract()
        self.assertEqual(self.evaluate()["decision"], "INTERNALLY_APPROVED")

    def test_input_parser_requires_attack_matrix_artifact(self):
        self.add_input_parser_contract(include_matrix=False)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        failures = " ".join(result["checks"]["artifacts"]["failures"] + result["checks"]["risk_coverage"]["failures"])
        self.assertIn("input-parser-attack-matrix", failures)

    def test_input_parser_requires_complete_mode_field_scope_cross_product(self):
        self.add_input_parser_contract(hierarchical=True, changed_path="src/ofx-parser.ts", omit_matrix_cell=True)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn(
            "mode x consumed-field x placement cells",
            " ".join(result["checks"]["risk_coverage"]["failures"]),
        )

    def test_input_parser_requires_stable_control_ids(self):
        self.add_input_parser_contract(omit_control="IP-EFFECT-001")
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn(
            "stable executed parser controls",
            " ".join(result["checks"]["risk_coverage"]["failures"]),
        )

    def test_input_parser_requires_limit_plus_one_and_external_padding_cases(self):
        self.add_input_parser_contract(
            raw_cases=[
                "empty",
                "whitespace-only",
                "limit-minus-one",
                "limit-exact",
                "invalid-encoding",
                "bom",
                "truncated",
            ]
        )
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        failures = " ".join(result["checks"]["risk_coverage"]["failures"])
        self.assertIn("limit-plus-one", failures)
        self.assertIn("valid-plus-external-padding-over-limit", failures)


    def test_hierarchical_input_parser_requires_scope_dimensions(self):
        requirement = self.state["requirements"][0]
        controls = []
        for index, dimension in enumerate((
            "raw-boundary-preservation",
            "validation-order-error-precedence",
            "syntax-mode-invariant-matrix",
        ), start=1):
            path, digest = self.write_json(f"hierarchical-parser-control-{index}.json", {"dimension": dimension, "result": "passed"})
            controls.append({
                "id": f"hierarchical-parser-control-{index}",
                "risk_family": "input-parser",
                "dimension": dimension,
                "failure_mode": f"Parser accepts invalid {dimension} input.",
                "plausible_wrong_implementation": f"Validate only the happy path for {dimension}.",
                "control_type": "test",
                "procedure": f"python -m unittest hierarchical_parser_control_{index}",
                "expected": "The invalid input is rejected without side effects.",
                "observed": "The invalid input was rejected without side effects.",
                "status": "passed",
                "evidence_path": path,
                "evidence_sha256": digest,
                "head_sha": HEAD,
                "sibling_cases": [f"alternate {dimension} case", f"second {dimension} mode"],
            })
        requirement["negative_controls"] = [item["id"] for item in controls]
        requirement["negative_control_evidence"] = controls
        coverage = json.loads((self.root / "coverage-matrix.json").read_text())
        coverage["requirements"][0]["negative_controls"] = requirement["negative_controls"]
        coverage["requirements"][0]["negative_control_evidence"] = controls
        self.rewrite_artifact(self.state, "coverage-matrix", coverage)
        self.state["risk_families"].append({
            "name": "input-parser", "applicable": True, "basis": "Hierarchical OFX parser changed",
            "required_gates": ["tests"], "required_subskills": [],
        })
        self.state["changed_files"].append({"path": "src/ofx-parser.ts", "families": ["input-parser"]})
        applicability = {
            "schema_version": 1, "complete": True,
            "changed_files": self.state["changed_files"], "risk_families": self.state["risk_families"],
        }
        self.rewrite_artifact(self.state, "applicability-ledger", applicability)
        self.sync_audit_report(self.state)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        failures = " ".join(result["checks"]["risk_coverage"]["failures"])
        self.assertIn("scope-membership", failures)
        self.assertIn("inactive-content", failures)
        self.assertIn("cross-scope-context", failures)

    def test_ui_family_requires_design_subskill(self):
        self.state["risk_families"].append({
            "name": "ui", "applicable": True, "basis": "UI file changed",
            "required_gates": ["tests"], "required_subskills": ["design-interface"],
        })
        self.state["changed_files"].append({"path": "src/Page.tsx", "families": ["ui"]})
        applicability = {
            "schema_version": 1, "complete": True,
            "changed_files": self.state["changed_files"], "risk_families": self.state["risk_families"],
        }
        self.rewrite_artifact(self.state, "applicability-ledger", applicability)
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_applicable_family_requires_gate(self):
        self.state["risk_families"].append({
            "name": "persistence", "applicable": True, "basis": "schema changed",
            "required_gates": [], "required_subskills": [],
        })
        self.state["changed_files"].append({"path": "schema.prisma", "families": ["persistence"]})
        applicability = {
            "schema_version": 1, "complete": True,
            "changed_files": self.state["changed_files"], "risk_families": self.state["risk_families"],
        }
        self.rewrite_artifact(self.state, "applicability-ledger", applicability)
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_closed_blocking_finding_requires_closure_evidence(self):
        finding = {
            "id": "F-1", "fingerprint": "same-bug", "severity": "Alto", "status": "closed",
            "disposition": "blocking", "occurrence_count": 1, "cause": "implementation-defect",
        }
        self.state["findings"] = [finding]
        self.state["learning_review"] = {
            "required": True, "completed": True, "reviewed_finding_ids": ["F-1"],
            "items": [{"finding_id": "F-1"}], "ledger_path": "learning.json", "ledger_sha256": None,
        }
        _, ledger_hash = self.write_json("learning.json", {"findings": ["F-1"]})
        self.state["learning_review"]["ledger_sha256"] = ledger_hash
        history = {"schema_version": 1, "append_only": True, "cycles": [{"cycle": 2, "finding_fingerprints": ["same-bug"]}]}
        self.rewrite_artifact(self.state, "cycle-history", history)
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_occurrence_count_is_derived_from_history(self):
        finding = {
            "id": "F-1", "fingerprint": "same-bug", "severity": "Alto", "status": "open",
            "disposition": "blocking", "occurrence_count": 1, "cause": "implementation-defect",
        }
        self.state["findings"] = [finding]
        self.state["learning_review"] = {
            "required": True, "completed": True, "reviewed_finding_ids": ["F-1"],
            "items": [{"finding_id": "F-1"}], "ledger_path": "learning.json", "ledger_sha256": None,
        }
        _, ledger_hash = self.write_json("learning.json", {"findings": ["F-1"]})
        self.state["learning_review"]["ledger_sha256"] = ledger_hash
        history = {
            "schema_version": 1, "append_only": True,
            "cycles": [
                {"cycle": 1, "finding_fingerprints": ["same-bug"]},
                {"cycle": 2, "finding_fingerprints": ["same-bug"]},
            ],
        }
        self.rewrite_artifact(self.state, "cycle-history", history)
        self.sync_audit_report(self.state)
        result = self.evaluate()
        self.assertEqual(result["decision"], "REMEDIATE")
        self.assertIn("occurrence_count", " ".join(result["checks"]["semantic_artifacts"]["failures"]))

    def test_audit_report_requirement_mismatch_blocks(self):
        self.sync_audit_report(self.state, lambda report: report.update({"requirements": []}))
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_gate_attestation_mismatch_blocks(self):
        self.state["gates"][0]["command"] = "false-command"
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_source_manifest_must_contain_requirement_origin(self):
        manifest = {"schema_version": 1, "complete": True, "sources": [{"id": "OTHER", "kind": "issue", "locator": "x", "sha256": HASH_A}]}
        self.rewrite_artifact(self.state, "source-manifest", manifest)
        rederive = json.loads((self.root / "requirements-rederivation.json").read_text())
        rederive["source_manifest_sha256"] = self.state["audit"]["source_manifest_sha256"]
        self.rewrite_artifact(self.state, "requirements-rederivation", rederive)
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "REMEDIATE")

    def test_absent_audit_requires_audit(self):
        self.state["audit"].update({
            "validity": "absent", "verdict": "not-run", "identity": None,
            "started_at": None, "finished_at": None, "read_only": False,
            "requirements_rederived": False, "neutral_packet_sha256": None,
            "implementation_conclusions_included": False,
            "implementation_narrative_included": False,
        })
        self.assertEqual(self.evaluate()["decision"], "AUDIT_REQUIRED")

    def test_first_independent_audit_escape_forces_root_cause_and_skill_improvement(self):
        self.state["audit"]["validity"] = "independent"
        self.state["audit"]["external_context_proven"] = True
        self.state["prior_internal_approval"] = {
            "head_sha": HEAD, "report_sha256": HASH_A,
            "assurance_level": "controller-adversarial",
            "approved_at": "2026-07-27T19:59:00Z",
        }
        finding = {
            "id": "F-ESC", "fingerprint": "retry-state-gap", "severity": "Alto",
            "status": "open", "disposition": "blocking", "occurrence_count": 1,
            "cause": "audit-defect", "requirement_id": "REQ-001",
        }
        self.state["findings"] = [finding]
        self.state["audit_escapes"] = [{
            "id": "ESC-1", "finding_id": "F-ESC", "fingerprint": "retry-state-gap",
            "affected_head_sha": HEAD, "prior_internal_report_sha256": HASH_A,
            "independent_report_sha256": HASH_B, "detected_at": "2026-07-27T20:02:00Z",
            "root_cause": None, "root_cause_completed": False,
            "skill_improvement_required": True, "skill_improvement_completed": False,
            "reusable_control_id": None,
        }]
        self.state["learning_review"] = {
            "required": True, "completed": True, "reviewed_finding_ids": ["F-ESC"],
            "items": [{"finding_id": "F-ESC"}], "ledger_path": "learning.json", "ledger_sha256": None,
        }
        _, ledger_hash = self.write_json("learning.json", {"findings": ["F-ESC"]})
        self.state["learning_review"]["ledger_sha256"] = ledger_hash
        history = {"schema_version": 1, "append_only": True, "cycles": [{"cycle": 2, "finding_fingerprints": ["retry-state-gap"]}]}
        self.rewrite_artifact(self.state, "cycle-history", history)
        self.sync_audit_report(self.state)
        result = self.evaluate()
        self.assertEqual(result["decision"], "ROOT_CAUSE_ANALYSIS")

    def test_completed_escape_with_skill_change_and_reusable_control_can_be_approved_independently(self):
        self.state["audit"]["validity"] = "independent"
        self.state["audit"]["external_context_proven"] = True
        self.state["prior_internal_approval"] = {
            "head_sha": OLD_HEAD, "report_sha256": HASH_A,
            "assurance_level": "controller-adversarial",
            "approved_at": "2026-07-27T19:00:00Z",
        }
        closure_path, closure_hash = self.write_json("escape-closure.json", {"verified": True, "head_sha": HEAD})
        control_path, control_hash = self.write_text("controls/retry-control.md", "Check every recoverable query error for a local retry action.\n")
        finding = {
            "id": "F-ESC", "fingerprint": "retry-state-gap", "severity": "Alto",
            "status": "closed", "disposition": "blocking", "occurrence_count": 1,
            "cause": "skill-defect", "requirement_id": "REQ-001",
            "detected_on_sha": OLD_HEAD, "remediated_on_sha": HEAD,
            "remediation_diff_sha256": HASH_B, "regression_test": "test_retry_on_profile_error",
            "closure_evidence_path": closure_path, "closure_evidence_sha256": closure_hash,
            "verified_cycle": 2,
        }
        escape = {
            "id": "ESC-1", "finding_id": "F-ESC", "fingerprint": "retry-state-gap",
            "affected_head_sha": OLD_HEAD, "prior_internal_report_sha256": HASH_A,
            "independent_report_sha256": HASH_B, "detected_at": "2026-07-27T19:30:00Z",
            "root_cause": "The internal audit enumerated one query section instead of the reusable error-state pattern.",
            "root_cause_completed": True, "skill_improvement_required": True,
            "skill_improvement_completed": True, "reusable_control_id": "CTRL-RETRY-1",
        }
        control = {
            "id": "CTRL-RETRY-1", "source_escape_id": "ESC-1",
            "fingerprint": "retry-state-gap", "risk_family": "ui",
            "description": "Check every recoverable query error for a local retry action.",
            "control_type": "checklist", "path": control_path, "sha256": control_hash, "active": True,
        }
        self.state["findings"] = [finding]
        self.state["audit_escapes"] = [escape]
        self.state["adversarial_controls"] = [control]
        self.state["skill_changes"] = [
            {"skill": "entregar-issue", "role": "prevention", "audit_escape_ids": ["ESC-1"], "changed_at": "2026-07-27T19:40:00Z"},
            {"skill": "auditar-issue", "role": "detection", "audit_escape_ids": ["ESC-1"], "changed_at": "2026-07-27T19:41:00Z"},
        ]
        self.state["learning_review"] = {
            "required": True, "completed": True, "reviewed_finding_ids": ["F-ESC"],
            "items": [{"finding_id": "F-ESC"}], "ledger_path": "learning.json", "ledger_sha256": None,
        }
        _, ledger_hash = self.write_json("learning.json", {"findings": ["F-ESC"]})
        self.state["learning_review"]["ledger_sha256"] = ledger_hash
        history = {"schema_version": 1, "append_only": True, "cycles": [{"cycle": 2, "finding_fingerprints": ["retry-state-gap"]}]}
        self.rewrite_artifact(self.state, "cycle-history", history)
        escape_ledger_path, escape_ledger_hash = self.write_json("audit-escape-ledger.json", {
            "schema_version": 1, "append_only": True, "escapes": [{"id": "ESC-1"}],
        })
        controls_ledger_path, controls_ledger_hash = self.write_json("adversarial-controls.json", {
            "schema_version": 1, "append_only": True, "controls": [{"id": "CTRL-RETRY-1"}],
        })
        self.state["artifacts"].extend([
            self.artifact("audit-escape-ledger", escape_ledger_path, escape_ledger_hash),
            self.artifact("adversarial-controls", controls_ledger_path, controls_ledger_hash),
        ])
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "APPROVED")

    def test_cycle_ten_with_failure_reaches_limit(self):
        self.state["cycle"] = 10
        self.state["requirements"][0]["negative_controls"] = []
        coverage = json.loads((self.root / "coverage-matrix.json").read_text())
        coverage["requirements"][0]["negative_controls"] = []
        self.rewrite_artifact(self.state, "coverage-matrix", coverage)
        history = {"schema_version": 1, "append_only": True, "cycles": [{"cycle": 10, "finding_fingerprints": []}]}
        self.rewrite_artifact(self.state, "cycle-history", history)
        self.sync_audit_report(self.state)
        self.assertEqual(self.evaluate()["decision"], "LIMIT_REACHED")


if __name__ == "__main__":
    unittest.main()
