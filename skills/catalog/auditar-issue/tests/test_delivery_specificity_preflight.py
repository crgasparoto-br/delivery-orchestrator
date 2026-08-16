from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEAD = "b" * 40
CANONICAL = [
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
]


def run(matrix: Path, risk: Path, inherited: Path):
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_delivery_saturation.py"),
         "--attack-matrix", str(matrix), "--risk-saturation", str(risk),
         "--inherited-controls", str(inherited), "--head-sha", HEAD],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )


def base_packet() -> tuple[dict, dict, dict]:
    matrix = {
        "head_sha": HEAD,
        "requirements": [{
            "requirement_id": "REQ-1",
            "plausible_wrong_implementation": "Record generic control labels while omitting the concrete boundary and discriminant behavior.",
            "positive_control": {"status": "passed", "head_sha": HEAD},
            "negative_controls": [{
                "status": "passed",
                "head_sha": HEAD,
                "failure_mode": "A generic handoff can claim success without identifying the boundary that was exercised.",
                "plausible_wrong_implementation": "Accept metadata that describes a passing test but omits the concrete failing mechanism.",
                "procedure": "Validate a handoff with concrete boundary details and inspect the specificity gate result.",
                "expected": "The preflight accepts only controls with a concrete discriminant mechanism and outcome.",
                "observed": "The preflight accepted the concrete control metadata and preserved the candidate identity.",
            }],
            "regression_controls": [{"status": "passed", "head_sha": HEAD}],
        }],
        "uncovered_requirements": [],
    }
    risk = {
        "head_sha": HEAD,
        "families": [
            {"family": family, "applicable": family == "structural-contract",
             "status": "passed" if family == "structural-contract" else "not-applicable",
             "control_ids": ["SPECIFICITY-001"] if family == "structural-contract" else []}
            for family in CANONICAL
        ],
        "material_families_missing_controls": [],
    }
    inherited = {"head_sha": HEAD, "controls": [], "unresolved_controls": []}
    return matrix, risk, inherited


def test_preflight_accepts_specific_attack_metadata() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix_path, risk_path, inherited_path = base / "matrix.json", base / "risk.json", base / "inherited.json"
        matrix, risk, inherited = base_packet()
        matrix_path.write_text(json.dumps(matrix), encoding="utf-8")
        risk_path.write_text(json.dumps(risk), encoding="utf-8")
        inherited_path.write_text(json.dumps(inherited), encoding="utf-8")
        proc = run(matrix_path, risk_path, inherited_path)
        assert proc.returncode == 0, proc.stdout


def test_preflight_rejects_generic_attack_placeholders() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix_path, risk_path, inherited_path = base / "matrix.json", base / "risk.json", base / "inherited.json"
        matrix, risk, inherited = base_packet()
        item = matrix["requirements"][0]
        item["plausible_wrong_implementation"] = "wrong implementation passes tests"
        item["negative_controls"][0].update({
            "failure_mode": "unsafe remains",
            "plausible_wrong_implementation": "wrong behavior still passes",
            "procedure": "run negative test",
            "expected": "rejected.",
            "observed": "it passed.",
        })
        matrix_path.write_text(json.dumps(matrix), encoding="utf-8")
        risk_path.write_text(json.dumps(risk), encoding="utf-8")
        inherited_path.write_text(json.dumps(inherited), encoding="utf-8")
        proc = run(matrix_path, risk_path, inherited_path)
        assert proc.returncode == 2
        assert "specific plausible wrong implementation" in proc.stdout
        assert "specific procedure" in proc.stdout
