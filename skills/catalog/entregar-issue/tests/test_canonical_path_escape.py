from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_SHA = hashlib.sha256(b"canonical negative").hexdigest()
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.specification import flags_for


def test_canonical_adapter_contract_is_classified_as_structural_canonical_path() -> None:
    text = (
        "A correção deve reutilizar canonical_parser e o executor canônico; "
        "não manter duas gramáticas concorrentes para a mesma ação e o adapter especializado "
        "não pode interceptar antes do caminho canonico."
    )
    flags = set(flags_for(text))
    assert "structural" in flags
    assert "canonical-path" in flags
    assert "forbidden-implementation" in flags
    assert "precedence" in flags


def test_handoff_blocks_structural_requirement_without_discriminant_closure() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        closure = base / "requirement-closure.json"
        closure.write_text(json.dumps({
            "obligations": [{
                "id": "OBL-001",
                "disposition": "covered",
                "flags": ["structural", "canonical-path"],
            }],
            "structural_invariant_closures": {
                "status": "passed",
                "applicability_reason": "A specialized parser competes with a canonical parser.",
                "entries": [],
                "unresolved_invariants": [],
            },
        }), encoding="utf-8")
        proc = subprocess.run([
            sys.executable,
            str(ROOT / "scripts" / "validate_handoff_readiness.py"),
            "--requirement-closure", str(closure),
        ], text=True, stdout=subprocess.PIPE)
        assert proc.returncode == 2
        assert "does not cover obligations" in proc.stdout


def test_handoff_accepts_canon_divergence_control_and_closed_escape() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        closure = base / "requirement-closure.json"
        closure.write_text(json.dumps({
            "obligations": [{
                "id": "OBL-001",
                "disposition": "covered",
                "flags": ["structural", "canonical-path"],
            }],
            "structural_invariant_closures": {
                "status": "passed",
                "applicability_reason": "A specialized parser competes with a canonical parser.",
                "entries": [{
                    "id": "SIC-001",
                    "obligation_ids": ["OBL-001"],
                    "plausible_wrong_implementation": "The specialized parser drops semantic_field and a later handler masks it.",
                    "negative_control_evidence": ["EV-CANON-DIVERGENCE-001"],
                }],
                "unresolved_invariants": [],
            },
        }), encoding="utf-8")
        matrix = base / "requirement-attack-matrix.json"
        matrix.write_text(json.dumps({
            "schema_version": 1,
            "head_sha": "e" * 40,
            "requirements": [{
                "requirement_id": "REQ-001",
                "obligation_ids": ["OBL-001"],
                "risk_families": ["structural-contract"],
                "risk_surfaces": [{"risk_family": "structural-contract", "surface": "canonical-parser-path", "reason": "A specialized parser competes with the canonical parser path."}],
                "plausible_wrong_implementation": "The specialized parser bypasses the canonical parser and silently drops one semantic field.",
                "positive_control": {"id": "POS-001", "status": "passed", "head_sha": "e" * 40, "evidence": "positive.log"},
                "negative_controls": [{
                    "id": "CANON-DIVERGENCE-001", "status": "passed", "head_sha": "e" * 40,
                    "evidence_path": "negative.log", "evidence_sha256": EVIDENCE_SHA,
                    "risk_family": "structural-contract", "surface": "canonical-parser-path", "dimension": "canonical-precedence",
                    "failure_mode": "The specialized parser intercepts before the canonical parser and drops semantics.",
                    "plausible_wrong_implementation": "Keep a specialized parser that bypasses the canonical path while happy-path fixtures remain equivalent.",
                    "control_type": "scenario", "procedure": "Feed divergent semantic fields through specialized and canonical parser paths.",
                    "expected": "The canonical parser remains authoritative for every semantic field.",
                    "observed": "The divergence control preserved the canonical parser as authoritative.",
                    "sibling_cases": [{"id": "S1", "surface": "canonical-parser-path", "dimension": "semantic-field-parity", "status": "passed"}]
                }],
                "regression_controls": [{"id": "REG-001", "status": "passed", "head_sha": "e" * 40, "evidence": "regression.log"}],
            }],
            "uncovered_requirements": [],
        }), encoding="utf-8")
        risk = base / "risk-saturation.json"
        canonical = ["authorization", "tenant-isolation", "public-boundary", "reference-liveness", "temporal-consistency", "temporal-destination", "concurrency-atomicity", "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation"]
        risk.write_text(json.dumps({
            "schema_version": 1, "head_sha": "e" * 40,
            "families": [{
                "family": name,
                "applicable": name == "structural-contract",
                "reason": "Structural canonical path requirement." if name == "structural-contract" else "Not applicable to this fixture.",
                "control_ids": ["CANON-DIVERGENCE-001"] if name == "structural-contract" else [],
                "dimensions": [{"surface": "canonical-parser-path", "reason": "A specialized parser competes with the canonical parser path.", "control_ids": ["CANON-DIVERGENCE-001"], "status": "passed"}] if name == "structural-contract" else [],
                "status": "passed" if name == "structural-contract" else "not-applicable",
            } for name in canonical],
            "material_families_missing_controls": [],
        }), encoding="utf-8")
        inherited = base / "inherited-controls.json"
        inherited.write_text(json.dumps({
            "schema_version": 1, "head_sha": "e" * 40,
            "source_audits": ["audit-prior"],
            "controls": [{"id": "CANON-DIVERGENCE-001", "status": "passed", "head_sha": "e" * 40, "evidence": "negative.log"}],
            "unresolved_controls": [],
        }), encoding="utf-8")
        escape = base / "audit-escape-closure.json"
        escape.write_text(json.dumps({
            "escape_id": "A-GENERIC-001",
            "escape_class": "canonical-path-divergence",
            "plausible_wrong_implementation": "The specialized parser intercepts before the canonical path and drops semantics.",
            "status": "passed",
            "required_risk_families": ["structural-contract"],
            "required_attack_dimensions": [
                {"risk_family": "structural-contract", "surface": "canonical-parser-path", "dimension": "canonical-precedence"},
                {"risk_family": "structural-contract", "surface": "canonical-parser-path", "dimension": "semantic-field-parity"},
            ],
            "sibling_cases": [
                {"id": "S1", "surface": "canonical-parser-path", "dimension": "canonical-precedence", "status": "passed"},
                {"id": "S2", "surface": "canonical-parser-path", "dimension": "semantic-field-parity", "status": "passed"},
            ],
            "prevention_change": {"evidence": "structural gate"},
            "detection_change": {"evidence": "CANON-DIVERGENCE-001"},
        }), encoding="utf-8")
        proc = subprocess.run([
            sys.executable,
            str(ROOT / "scripts" / "validate_handoff_readiness.py"),
            "--requirement-closure", str(closure),
            "--attack-matrix", str(matrix),
            "--risk-saturation", str(risk),
            "--inherited-controls", str(inherited),
            "--audit-escape-closure", str(escape),
            "--previous-independent-rejection",
        ], text=True, stdout=subprocess.PIPE)
        assert proc.returncode == 0, proc.stdout
