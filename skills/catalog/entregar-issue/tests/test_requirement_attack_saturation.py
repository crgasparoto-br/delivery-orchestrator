from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.specification import flags_for

HEAD = "a" * 40


def run(script: str, *args: str):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *args], text=True, stdout=subprocess.PIPE)


def test_specification_detects_reference_liveness_and_temporal_destination() -> None:
    flags = set(flags_for("Após aprovação, referências obrigatórias continuam válidas e a nova liberação usa somente alvo futuro da semana selecionada."))
    assert "reference-liveness" in flags
    assert "temporal-destination" in flags
    assert "temporal" in flags


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
                "plausible_wrong_implementation": "Validate the reference only during approval and never again during release.",
                "positive_control": {"id": "POS-1", "status": "passed", "head_sha": HEAD, "evidence": "positive.log"},
                "negative_controls": [{"id": "REF-LIVE-001", "status": "passed", "head_sha": HEAD, "evidence": "negative.log", "sibling_cases": [{"id": "S1", "status": "passed"}, {"id": "S2", "status": "passed"}]}],
                "regression_controls": [{"id": "REG-1", "status": "passed", "head_sha": HEAD, "evidence": "regression.log"}],
            }],
            "uncovered_requirements": [],
        }), encoding="utf-8")
        proc = run("validate_requirement_attack_matrix.py", "--requirement-closure", str(closure), "--attack-matrix", str(matrix))
        assert proc.returncode == 0, proc.stdout


def test_risk_saturation_requires_every_canonical_family_and_active_control() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix = base / "requirement-attack-matrix.json"
        matrix.write_text(json.dumps({
            "schema_version": 1, "head_sha": HEAD,
            "requirements": [{"requirement_id": "REQ-001", "risk_families": ["temporal-destination"], "negative_controls": [{"id": "TEMP-DEST-001"}]}],
            "uncovered_requirements": [],
        }), encoding="utf-8")
        risk = base / "risk-saturation.json"
        proc = run("init_risk_saturation.py", "--attack-matrix", str(matrix), "--out", str(risk))
        assert proc.returncode == 0
        data = json.loads(risk.read_text())
        for item in data["families"]:
            if item["family"] == "temporal-destination":
                item["status"] = "passed"
        risk.write_text(json.dumps(data), encoding="utf-8")
        proc = run("validate_risk_saturation.py", "--attack-matrix", str(matrix), "--risk-saturation", str(risk))
        assert proc.returncode == 0, proc.stdout
