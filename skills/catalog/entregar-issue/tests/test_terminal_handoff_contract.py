from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_terminal_handoff.py"


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def _fixture(base: Path, material: str = "a" * 40):
    artifacts = base / "artifacts"
    artifacts.mkdir()
    names = {
        "specification_snapshot": "specification-snapshot.json",
        "requirement_closure": "requirement-closure.json",
        "requirement_attack_matrix": "requirement-attack-matrix.json",
        "risk_saturation": "risk-saturation.json",
        "inherited_controls": "inherited-controls.json",
    }
    import hashlib
    artifact_entries = {}
    for key, name in names.items():
        path = artifacts / name
        path.write_text("{}\n", encoding="utf-8")
        artifact_entries[key] = {"name": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    cert = base / "handoff-ready.json"
    allowed = [".audit/entregar-issue/handoff-ready.json"] + [
        f".audit/entregar-issue/{name}" for name in names.values()
    ]
    _write_json(cert, {
        "schema_version": 2,
        "status": "ready",
        "identity": {"head_sha": material, "material_head_sha": material, "base_sha": "b" * 40},
        "certificate_commit_policy": {"mode": "result-only-child", "allowed_paths": allowed},
        "contract_version": "2026-08-06.2",
        "producer": {"skill": "entregar-issue", "skill_sha256": "c" * 64},
        "artifacts": artifact_entries,
        "previous_independent_rejection": False,
    })
    return cert, artifacts, allowed


def _run(cert: Path, artifacts: Path, material: str, published: str, parent: str, paths: list[str]):
    cmd = [
        sys.executable, str(SCRIPT),
        "--certificate", str(cert),
        "--artifacts-dir", str(artifacts),
        "--material-head-sha", material,
        "--published-head-sha", published,
        "--published-parent-sha", parent,
        "--base-sha", "b" * 40,
        "--contract-version", "2026-08-06.2",
    ]
    for path in paths:
        cmd += ["--published-changed-path", path]
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def test_terminal_guard_requires_actual_published_child() -> None:
    with tempfile.TemporaryDirectory() as td:
        material = "a" * 40
        cert, artifacts, allowed = _fixture(Path(td), material)
        proc = _run(cert, artifacts, material, material, material, allowed)
        assert proc.returncode == 2
        assert "remote head is still the material head" in proc.stdout


def test_terminal_guard_rejects_material_path_in_handoff_child() -> None:
    with tempfile.TemporaryDirectory() as td:
        material = "a" * 40
        published = "d" * 40
        cert, artifacts, allowed = _fixture(Path(td), material)
        proc = _run(cert, artifacts, material, published, material, allowed + ["server/app.ts"])
        assert proc.returncode == 2
        assert "non-handoff paths" in proc.stdout


def test_terminal_guard_accepts_direct_result_only_child() -> None:
    with tempfile.TemporaryDirectory() as td:
        material = "a" * 40
        published = "d" * 40
        cert, artifacts, allowed = _fixture(Path(td), material)
        proc = _run(cert, artifacts, material, published, material, allowed)
        assert proc.returncode == 0, proc.stdout
        assert "READY: terminal handoff published" in proc.stdout


def test_pending_ci_is_not_allowed_to_skip_handoff() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    remote = (ROOT / "references" / "remote-gate.md").read_text(encoding="utf-8")
    efficiency = (ROOT / "references" / "controller-execution-efficiency.md").read_text(encoding="utf-8")
    assert "publicacao do handoff" in skill
    assert "CI `pending-no-run`" in skill
    assert "nunca justificam ausencia" in remote
    assert "Barreira terminal de handoff" in efficiency
