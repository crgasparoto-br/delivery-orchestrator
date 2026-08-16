from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEAD = "a" * 40
EVIDENCE_SHA = hashlib.sha256(b"evidence").hexdigest()


def run(script: str, *args: str):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def closure(path: Path):
    path.write_text(json.dumps({"obligations": [{"id": "OBL-1", "disposition": "covered", "requirement_ids": ["REQ-1"]}]}), encoding="utf-8")


def base_control(surface: str, dimension: str, sibling_surfaces: tuple[str, str]):
    return {
        "id": f"NEG-{surface}",
        "status": "passed",
        "head_sha": HEAD,
        "evidence_path": "negative.log",
        "evidence_sha256": EVIDENCE_SHA,
        "risk_family": "authorization",
        "surface": surface,
        "dimension": dimension,
        "failure_mode": f"Cross-role secret becomes readable through the {surface} boundary by the wrong role.",
        "plausible_wrong_implementation": f"Filter only one {surface} secret channel while another cross-role channel remains readable.",
        "control_type": "procedure",
        "procedure": f"Probe the {surface} role boundary against the frozen candidate and inspect access.",
        "expected": f"The {surface} boundary denies the wrong role before protected data is exposed.",
        "observed": f"The {surface} boundary denied the wrong role before protected data was exposed.",
        "semantic_evidence": {
            "mechanism": {"surface": surface, "dimension": dimension, "target": f"{surface} {dimension} cross-role secret boundary"},
            "procedure": {"operation": "probe", "stimulus": f"probe {surface} cross-role secret access on the frozen candidate", "observable": f"{surface} boundary reports whether protected secret bytes are readable"},
            "outcome": {"expected_signal": f"The {surface} boundary denies the wrong role before protected data is exposed.", "observed_signal": f"The {surface} boundary denied the wrong role before protected data was exposed.", "evidence_sha256": EVIDENCE_SHA},
        },
        "sibling_cases": [
            {"id": "S1", "surface": sibling_surfaces[0], "dimension": "reciprocal-role", "status": "passed"},
            {"id": "S2", "surface": sibling_surfaces[1], "dimension": "alternate-channel", "status": "passed"},
        ],
    }


def matrix_data(include_filesystem=True, declare_filesystem=True):
    surfaces = [
        {"risk_family": "authorization", "surface": "environment", "reason": "Role credentials cross process environment boundaries."},
        {"risk_family": "authorization", "surface": "persistent-credential-store", "reason": "Role-specific auth cache persists outside the workspace."},
        {"risk_family": "authorization", "surface": "process-identity", "reason": "Both roles may execute under the same operating-system identity."},
    ]
    if declare_filesystem:
        surfaces.append({"risk_family": "authorization", "surface": "filesystem", "reason": "Signing material is stored in files visible to role processes."})
    controls = [base_control("environment", "env-secret-filtering", ("environment", "persistent-credential-store"))]
    controls.append(base_control("persistent-credential-store", "cross-home-readability", ("persistent-credential-store", "environment")))
    controls.append(base_control("process-identity", "same-user-boundary", ("process-identity", "filesystem" if declare_filesystem else "environment")))
    if include_filesystem:
        controls.append(base_control("filesystem", "cross-role-file-readability", ("filesystem", "environment")))
    return {
        "schema_version": 1,
        "head_sha": HEAD,
        "requirements": [{
            "requirement_id": "REQ-1",
            "obligation_ids": ["OBL-1"],
            "risk_families": ["authorization"],
            "risk_surfaces": surfaces,
            "plausible_wrong_implementation": "Filter process.env but leave a signing key readable through the filesystem and a persistent CODEX_HOME auth.json shared by the same runner user.",
            "positive_control": {"id": "POS", "status": "passed", "head_sha": HEAD, "evidence": "positive.log"},
            "negative_controls": controls,
            "regression_controls": [{"id": "REG", "status": "passed", "head_sha": HEAD, "evidence": "regression.log"}],
        }],
        "uncovered_requirements": [],
    }


def test_attack_matrix_rejects_obvious_filesystem_surface_omission():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        c = base / "closure.json"; closure(c)
        m = base / "matrix.json"; m.write_text(json.dumps(matrix_data(include_filesystem=False, declare_filesystem=False)), encoding="utf-8")
        proc = run("validate_requirement_attack_matrix.py", "--requirement-closure", str(c), "--attack-matrix", str(m))
        assert proc.returncode == 2
        assert "omits inferred risk surfaces" in proc.stdout
        assert "filesystem" in proc.stdout


def test_attack_matrix_rejects_declared_surface_without_control():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        c = base / "closure.json"; closure(c)
        m = base / "matrix.json"; m.write_text(json.dumps(matrix_data(include_filesystem=False, declare_filesystem=True)), encoding="utf-8")
        proc = run("validate_requirement_attack_matrix.py", "--requirement-closure", str(c), "--attack-matrix", str(m))
        assert proc.returncode == 2
        assert "risk surfaces without adversarial coverage" in proc.stdout
        assert "authorization:filesystem" in proc.stdout


def test_cross_surface_matrix_and_saturation_pass_when_every_surface_is_covered():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        c = base / "closure.json"; closure(c)
        m = base / "matrix.json"; m.write_text(json.dumps(matrix_data()), encoding="utf-8")
        proc = run("validate_requirement_attack_matrix.py", "--requirement-closure", str(c), "--attack-matrix", str(m))
        assert proc.returncode == 0, proc.stdout

        r = base / "risk.json"
        proc = run("init_risk_saturation.py", "--attack-matrix", str(m), "--out", str(r))
        assert proc.returncode == 0, proc.stdout
        data = json.loads(r.read_text())
        auth = next(item for item in data["families"] if item["family"] == "authorization")
        auth["status"] = "passed"
        for dimension in auth["dimensions"]:
            dimension["status"] = "passed"
        r.write_text(json.dumps(data), encoding="utf-8")
        proc = run("validate_risk_saturation.py", "--attack-matrix", str(m), "--risk-saturation", str(r))
        assert proc.returncode == 0, proc.stdout


def test_risk_saturation_rejects_missing_surface_dimension():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        m = base / "matrix.json"; m.write_text(json.dumps(matrix_data()), encoding="utf-8")
        r = base / "risk.json"
        run("init_risk_saturation.py", "--attack-matrix", str(m), "--out", str(r))
        data = json.loads(r.read_text())
        auth = next(item for item in data["families"] if item["family"] == "authorization")
        auth["status"] = "passed"
        auth["dimensions"] = [d for d in auth["dimensions"] if d["surface"] != "filesystem"]
        for dimension in auth["dimensions"]:
            dimension["status"] = "passed"
        r.write_text(json.dumps(data), encoding="utf-8")
        proc = run("validate_risk_saturation.py", "--attack-matrix", str(m), "--risk-saturation", str(r))
        assert proc.returncode == 2
        assert "omits required surfaces" in proc.stdout
        assert "filesystem" in proc.stdout


def test_risk_saturation_rejects_escape_closed_without_cross_surface_dimensions():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        m = base / "requirement-attack-matrix.json"; m.write_text(json.dumps(matrix_data()), encoding="utf-8")
        escape = base / "audit-escape-closure.json"
        escape.write_text(json.dumps({"schema_version": 1, "escapes": [{
            "escape_id": "A-1",
            "escape_class": "role-secret-boundary-leak",
            "required_risk_families": ["authorization"],
            "required_attack_dimensions": [
                {"risk_family": "authorization", "surface": "environment", "dimension": "env-secret-filtering"},
                {"risk_family": "authorization", "surface": "filesystem", "dimension": "missing-dimension"},
            ],
            "status": "passed",
        }]}), encoding="utf-8")
        r = base / "risk.json"
        run("init_risk_saturation.py", "--attack-matrix", str(m), "--out", str(r))
        data = json.loads(r.read_text())
        auth = next(item for item in data["families"] if item["family"] == "authorization")
        auth["status"] = "passed"
        for dimension in auth["dimensions"]:
            dimension["status"] = "passed"
        r.write_text(json.dumps(data), encoding="utf-8")
        proc = run("validate_risk_saturation.py", "--attack-matrix", str(m), "--risk-saturation", str(r))
        assert proc.returncode == 2
        assert "audit escape required attack dimensions are not covered" in proc.stdout
        assert "authorization:filesystem:missing-dimension" in proc.stdout


def test_risk_saturation_accepts_escape_when_required_dimensions_are_covered():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        m = base / "requirement-attack-matrix.json"; m.write_text(json.dumps(matrix_data()), encoding="utf-8")
        escape = base / "audit-escape-closure.json"
        escape.write_text(json.dumps({"schema_version": 1, "escapes": [{
            "escape_id": "A-1",
            "escape_class": "role-secret-boundary-leak",
            "required_risk_families": ["authorization"],
            "required_attack_dimensions": [
                {"risk_family": "authorization", "surface": "environment", "dimension": "env-secret-filtering"},
                {"risk_family": "authorization", "surface": "filesystem", "dimension": "cross-role-file-readability"},
            ],
            "status": "passed",
        }]}), encoding="utf-8")
        r = base / "risk.json"
        run("init_risk_saturation.py", "--attack-matrix", str(m), "--out", str(r))
        data = json.loads(r.read_text())
        auth = next(item for item in data["families"] if item["family"] == "authorization")
        auth["status"] = "passed"
        for dimension in auth["dimensions"]:
            dimension["status"] = "passed"
        r.write_text(json.dumps(data), encoding="utf-8")
        proc = run("validate_risk_saturation.py", "--attack-matrix", str(m), "--risk-saturation", str(r))
        assert proc.returncode == 0, proc.stdout
