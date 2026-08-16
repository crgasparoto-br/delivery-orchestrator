from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(path: Path, inherited: Path, head: str):
    return subprocess.run([
        sys.executable, str(ROOT / "scripts" / "check_reaudit_readiness.py"),
        "--closure", str(path),
        "--inherited-controls", str(inherited),
        "--head-sha", head,
    ], text=True, stdout=subprocess.PIPE)


def test_reaudit_stops_before_full_audit_when_escape_is_incomplete() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        closure = Path(tmp) / "audit-escape-closure.json"
        head = "c" * 40
        inherited = Path(tmp) / "inherited-controls.json"
        inherited.write_text(json.dumps({"schema_version": 1, "head_sha": head, "controls": [{"id": "CANON-DIVERGENCE-001", "status": "passed", "head_sha": head, "evidence": "evidence.log"}], "unresolved_controls": []}), encoding="utf-8")
        closure.write_text(json.dumps({
            "escape_id": "A-970-001",
            "escape_class": "canonical-path-divergence",
            "plausible_wrong_implementation": "A specialized path intercepts before the canonical parser and drops semantics.",
            "status": "passed",
            "sibling_cases": [{"id": "only-one", "status": "passed"}],
            "prevention_change": {"evidence": "ok"},
            "detection_change": {"evidence": "ok"},
        }), encoding="utf-8")
        proc = run(closure, inherited, head)
        assert proc.returncode == 2
        assert "sibling cases are incomplete" in proc.stdout


def test_reaudit_accepts_closed_escape_class() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        closure = Path(tmp) / "audit-escape-closure.json"
        head = "d" * 40
        inherited = Path(tmp) / "inherited-controls.json"
        inherited.write_text(json.dumps({"schema_version": 1, "head_sha": head, "controls": [{"id": "CANON-DIVERGENCE-001", "status": "passed", "head_sha": head, "evidence": "evidence.log"}], "unresolved_controls": []}), encoding="utf-8")
        closure.write_text(json.dumps({
            "escape_id": "A-970-001",
            "escape_class": "canonical-path-divergence",
            "plausible_wrong_implementation": "A specialized path intercepts before the canonical parser and drops semantics.",
            "status": "passed",
            "sibling_cases": [
                {"id": "verb-preposition", "status": "passed"},
                {"id": "alias-order", "status": "passed"},
            ],
            "prevention_change": {"evidence": "delivery structural gate"},
            "detection_change": {"evidence": "CANON-DIVERGENCE-001"},
        }), encoding="utf-8")
        proc = run(closure, inherited, head)
        assert proc.returncode == 0, proc.stdout
