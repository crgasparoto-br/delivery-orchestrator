from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEAD = "a" * 40
EVIDENCE_SHA = hashlib.sha256(b"specificity-evidence").hexdigest()


def run(closure: Path, matrix: Path):
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_requirement_attack_matrix.py"),
         "--requirement-closure", str(closure), "--attack-matrix", str(matrix)],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )


def valid_matrix() -> dict:
    return {
        "schema_version": 1,
        "head_sha": HEAD,
        "requirements": [{
            "requirement_id": "REQ-001",
            "obligation_ids": ["OBL-001"],
            "risk_families": ["structural-contract"],
            "risk_surfaces": [{
                "risk_family": "structural-contract",
                "surface": "handoff-control-evidence",
                "reason": "The handoff must contain reproducible adversarial evidence.",
            }],
            "plausible_wrong_implementation": "Record generic control labels while omitting the concrete boundary and discriminant behavior.",
            "positive_control": {"id": "POS-1", "status": "passed", "head_sha": HEAD, "evidence": "evidence.log"},
            "negative_controls": [{
                "id": "SPECIFICITY-001",
                "status": "passed",
                "head_sha": HEAD,
                "evidence": "evidence.log",
                "evidence_sha256": EVIDENCE_SHA,
                "risk_family": "structural-contract",
                "surface": "handoff-control-evidence",
                "dimension": "reproducible-procedure",
                "failure_mode": "A generic handoff can claim a passed adversarial control without naming the exercised boundary.",
                "plausible_wrong_implementation": "Accept metadata that says a wrong behavior passes while omitting the concrete failing mechanism.",
                "control_type": "gate",
                "procedure": "Validate a handoff containing generic attack prose and require the specificity gate to reject it.",
                "expected": "The validator rejects metadata that does not identify a concrete discriminant mechanism.",
                "observed": "The validator rejected the generic metadata before the handoff could be certified.",
                "sibling_cases": [{
                    "id": "S1", "surface": "handoff-control-evidence", "dimension": "concrete-outcome", "status": "passed"
                }],
            }],
            "regression_controls": [{"id": "REG-1", "status": "passed", "head_sha": HEAD, "evidence": "evidence.log"}],
        }],
        "uncovered_requirements": [],
    }


def test_specific_adversarial_metadata_passes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        closure = base / "closure.json"
        matrix = base / "matrix.json"
        closure.write_text(json.dumps({"obligations": [{"id": "OBL-001", "disposition": "covered", "requirement_ids": ["REQ-001"]}]}), encoding="utf-8")
        matrix.write_text(json.dumps(valid_matrix()), encoding="utf-8")
        proc = run(closure, matrix)
        assert proc.returncode == 0, proc.stdout


def test_generic_placeholder_metadata_is_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        closure = base / "closure.json"
        matrix = base / "matrix.json"
        closure.write_text(json.dumps({"obligations": [{"id": "OBL-001", "disposition": "covered", "requirement_ids": ["REQ-001"]}]}), encoding="utf-8")
        data = valid_matrix()
        item = data["requirements"][0]
        item["plausible_wrong_implementation"] = "wrong implementation passes tests"
        control = item["negative_controls"][0]
        control.update({
            "failure_mode": "unsafe remains",
            "plausible_wrong_implementation": "wrong behavior still passes",
            "procedure": "run negative test",
            "expected": "rejected.",
            "observed": "it passed.",
        })
        matrix.write_text(json.dumps(data), encoding="utf-8")
        proc = run(closure, matrix)
        assert proc.returncode == 2
        assert "not specific enough" in proc.stdout or "generic placeholder" in proc.stdout
