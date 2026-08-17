from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
HEAD = "a" * 40
EVIDENCE_SHA = hashlib.sha256(b"negative").hexdigest()


def run(script: str, *args: str):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def negative_control(control_id: str, family: str, surface: str, dimension: str):
    return {
        "id": control_id,
        "status": "passed",
        "head_sha": HEAD,
        "evidence_path": "negative.log",
        "evidence_sha256": EVIDENCE_SHA,
        "risk_family": family,
        "surface": surface,
        "dimension": dimension,
        "failure_mode": f"A stale or unauthorized value crosses the {surface} protected boundary.",
        "plausible_wrong_implementation": f"Validate only the happy path and skip the definitive {surface} boundary check.",
        "control_type": "scenario",
        "procedure": f"Execute the {surface} discriminant scenario against the frozen candidate.",
        "expected": f"The {surface} boundary rejects the invalid state at {dimension}.",
        "observed": f"The {surface} boundary rejected the invalid state at {dimension}.",
        "semantic_evidence": {
            "mechanism": {"surface": surface, "dimension": dimension, "target": f"{surface} {dimension} protected boundary"},
            "procedure": {"operation": "execute", "stimulus": f"execute {surface} discriminant scenario against the frozen candidate", "observable": f"{surface} boundary returns the discriminant decision"},
            "outcome": {"expected_signal": f"The {surface} boundary rejects the invalid state at {dimension}.", "observed_signal": f"The {surface} boundary rejected the invalid state at {dimension}.", "evidence_sha256": EVIDENCE_SHA},
        },
        "sibling_cases": [
            {"id": "S1", "surface": surface, "dimension": "deleted-reference", "status": "passed"},
            {"id": "S2", "surface": surface, "dimension": "changed-eligibility", "status": "passed"},
        ],
    }


def test_attack_matrix_requires_discriminant_controls_and_regression() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        closure = base / "requirement-closure.json"
        closure.write_text(json.dumps({"obligations": [{"id": "OBL-001", "disposition": "covered", "requirement_ids": ["REQ-001"]}]}), encoding="utf-8")
        matrix = base / "requirement-attack-matrix.json"
        matrix.write_text(json.dumps({
            "schema_version": 1,
            "head_sha": HEAD,
            "requirements": [{
                "requirement_id": "REQ-001",
                "obligation_ids": ["OBL-001"],
                "risk_families": ["reference-liveness"],
                "risk_surfaces": [{"risk_family": "reference-liveness", "surface": "reference-store", "reason": "Persisted references are consumed after approval."}],
                "plausible_wrong_implementation": "Validate the reference only during approval and never again during release.",
                "positive_control": {"id": "POS-1", "status": "passed", "head_sha": HEAD, "evidence": "positive.log"},
                "negative_controls": [negative_control("REF-LIVE-001", "reference-liveness", "reference-store", "release-time-liveness")],
                "regression_controls": [{"id": "REG-1", "status": "passed", "head_sha": HEAD, "evidence": "regression.log"}],
            }],
            "uncovered_requirements": [],
        }), encoding="utf-8")
        proc = run("validate_requirement_attack_matrix.py", "--requirement-closure", str(closure), "--attack-matrix", str(matrix))
        assert proc.returncode == 0, proc.stdout


def test_risk_saturation_requires_every_canonical_family_surface_and_active_control() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix = base / "requirement-attack-matrix.json"
        matrix.write_text(json.dumps({
            "schema_version": 1, "head_sha": HEAD,
            "requirements": [{
                "requirement_id": "REQ-001",
                "risk_families": ["temporal-destination"],
                "risk_surfaces": [{"risk_family": "temporal-destination", "surface": "destination-selector", "reason": "A concrete date selects a future destination."}],
                "negative_controls": [negative_control("TEMP-DEST-001", "temporal-destination", "destination-selector", "future-destination")],
            }],
            "uncovered_requirements": [],
        }), encoding="utf-8")
        risk = base / "risk-saturation.json"
        proc = run("init_risk_saturation.py", "--attack-matrix", str(matrix), "--out", str(risk))
        assert proc.returncode == 0
        data = json.loads(risk.read_text())
        for item in data["families"]:
            if item["family"] == "temporal-destination":
                item["status"] = "passed"
                for dimension in item["dimensions"]:
                    dimension["status"] = "passed"
        risk.write_text(json.dumps(data), encoding="utf-8")
        proc = run("validate_risk_saturation.py", "--attack-matrix", str(matrix), "--risk-saturation", str(risk))
        assert proc.returncode == 0, proc.stdout
