from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEAD = "d" * 40
BASE = "e" * 40
MERGE = "f" * 40
CANONICAL = [
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args: str):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / "check_delivery_preflight.py"), *args], text=True, stdout=subprocess.PIPE)


def write_packet(base: Path) -> tuple[Path, Path, Path, Path]:
    spec = base / "specification-snapshot.json"; spec.write_text("{}", encoding="utf-8")
    closure = base / "requirement-closure.json"; closure.write_text("{}", encoding="utf-8")
    matrix = base / "requirement-attack-matrix.json"
    matrix.write_text(json.dumps({
        "head_sha": HEAD,
        "requirements": [{
            "requirement_id": "REQ-1",
            "plausible_wrong_implementation": "The implementation preserves the happy path but violates a sibling path.",
            "positive_control": {"status": "passed", "head_sha": HEAD},
            "negative_controls": [{"status": "passed", "head_sha": HEAD}],
            "regression_controls": [{"status": "passed", "head_sha": HEAD}],
        }],
        "uncovered_requirements": [],
    }), encoding="utf-8")
    risk = base / "risk-saturation.json"
    risk.write_text(json.dumps({
        "head_sha": HEAD,
        "families": [{"family": family, "applicable": False, "status": "not-applicable", "control_ids": []} for family in CANONICAL],
        "material_families_missing_controls": [],
    }), encoding="utf-8")
    inherited = base / "inherited-controls.json"
    inherited.write_text(json.dumps({"head_sha": HEAD, "controls": [], "unresolved_controls": []}), encoding="utf-8")
    return matrix, risk, inherited, closure


def make_certificate(base: Path, matrix: Path, risk: Path, inherited: Path, closure: Path) -> Path:
    spec = base / "specification-snapshot.json"
    cert = base / "handoff-ready.json"
    artifacts = {
        "specification_snapshot": spec,
        "requirement_closure": closure,
        "requirement_attack_matrix": matrix,
        "risk_saturation": risk,
        "inherited_controls": inherited,
    }
    cert.write_text(json.dumps({
        "schema_version": 1,
        "status": "ready",
        "identity": {"head_sha": HEAD, "base_sha": BASE, "merge_preview_sha": MERGE},
        "contract_version": "2026-08-06.2",
        "producer": {"skill": "entregar-issue", "skill_sha256": "a" * 64},
        "validators": {},
        "artifacts": {key: {"name": path.name, "sha256": sha(path)} for key, path in artifacts.items()},
        "previous_independent_rejection": False,
    }), encoding="utf-8")
    return cert


def test_preflight_rejects_missing_certificate_before_broad_audit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix, risk, inherited, _ = write_packet(base)
        proc = run(
            "--certificate", str(base / "missing.json"), "--artifacts-dir", str(base),
            "--attack-matrix", str(matrix), "--risk-saturation", str(risk),
            "--inherited-controls", str(inherited), "--head-sha", HEAD, "--base-sha", BASE,
            "--merge-preview-sha", MERGE, "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 2
        assert "invalid handoff certificate" in proc.stdout


def test_preflight_accepts_certified_saturated_packet() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix, risk, inherited, closure = write_packet(base)
        cert = make_certificate(base, matrix, risk, inherited, closure)
        proc = run(
            "--certificate", str(cert), "--artifacts-dir", str(base),
            "--attack-matrix", str(matrix), "--risk-saturation", str(risk),
            "--inherited-controls", str(inherited), "--head-sha", HEAD, "--base-sha", BASE,
            "--merge-preview-sha", MERGE, "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 0, proc.stdout


def test_preflight_accepts_result_only_child_and_validates_material_head() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix, risk, inherited, closure = write_packet(base)
        spec = base / "specification-snapshot.json"
        cert = base / "handoff-ready.json"
        artifacts = {
            "specification_snapshot": spec,
            "requirement_closure": closure,
            "requirement_attack_matrix": matrix,
            "risk_saturation": risk,
            "inherited_controls": inherited,
        }
        allowed = [f".audit/entregar-issue/{path.name}" for path in artifacts.values()]
        allowed.append(".audit/entregar-issue/handoff-ready.json")
        cert.write_text(json.dumps({
            "schema_version": 2,
            "status": "ready",
            "identity": {
                "head_sha": HEAD,
                "material_head_sha": HEAD,
                "base_sha": BASE,
                "merge_preview_sha": MERGE,
                "material_merge_preview_sha": MERGE,
            },
            "certificate_commit_policy": {"mode": "result-only-child", "allowed_paths": allowed},
            "contract_version": "2026-08-06.2",
            "producer": {"skill": "entregar-issue", "skill_sha256": "a" * 64},
            "validators": {},
            "artifacts": {key: {"name": path.name, "sha256": sha(path)} for key, path in artifacts.items()},
            "previous_independent_rejection": False,
        }), encoding="utf-8")
        published = "1" * 40
        proc = run(
            "--certificate", str(cert), "--artifacts-dir", str(base),
            "--attack-matrix", str(matrix), "--risk-saturation", str(risk),
            "--inherited-controls", str(inherited), "--head-sha", published, "--base-sha", BASE,
            "--merge-preview-sha", "2" * 40, "--candidate-parent-sha", HEAD,
            "--candidate-changed-path", ".audit/entregar-issue/handoff-ready.json",
            "--candidate-changed-path", ".audit/entregar-issue/requirement-attack-matrix.json",
            "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 0, proc.stdout
        assert "preserves material head" in proc.stdout


def test_preflight_rejects_result_only_child_with_product_change() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        matrix, risk, inherited, closure = write_packet(base)
        spec = base / "specification-snapshot.json"
        cert = base / "handoff-ready.json"
        artifacts = {
            "specification_snapshot": spec,
            "requirement_closure": closure,
            "requirement_attack_matrix": matrix,
            "risk_saturation": risk,
            "inherited_controls": inherited,
        }
        cert.write_text(json.dumps({
            "schema_version": 2,
            "status": "ready",
            "identity": {"head_sha": HEAD, "material_head_sha": HEAD, "base_sha": BASE},
            "certificate_commit_policy": {
                "mode": "result-only-child",
                "allowed_paths": [".audit/entregar-issue/handoff-ready.json"],
            },
            "contract_version": "2026-08-06.2",
            "producer": {"skill": "entregar-issue", "skill_sha256": "a" * 64},
            "validators": {},
            "artifacts": {key: {"name": path.name, "sha256": sha(path)} for key, path in artifacts.items()},
            "previous_independent_rejection": False,
        }), encoding="utf-8")
        proc = run(
            "--certificate", str(cert), "--artifacts-dir", str(base),
            "--attack-matrix", str(matrix), "--risk-saturation", str(risk),
            "--inherited-controls", str(inherited), "--head-sha", "1" * 40, "--base-sha", BASE,
            "--candidate-parent-sha", HEAD,
            "--candidate-changed-path", "server/product.ts",
            "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 2
        assert "non-handoff paths" in proc.stdout
