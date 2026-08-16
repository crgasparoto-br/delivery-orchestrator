from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_learning_closure.py"
GENERICITY = ROOT / "scripts" / "validate_skill_genericity.py"


def run_learning(path: Path):
    return subprocess.run(
        [sys.executable, str(VALIDATOR), "--learning-closure", str(path)],
        text=True,
        stdout=subprocess.PIPE,
    )


def systemic_payload() -> dict:
    return {
        "schema_version": 1,
        "classification": "systemic-escape",
        "source_event": {"kind": "independent-rejection", "finding_ids": ["A-001"]},
        "generalized_learning": {
            "promotion_status": "promoted",
            "escape_class": "canonical-source-divergence",
            "generalized_failure_pattern": "A specialized adapter can return a poorer semantic state than the canonical path.",
            "plausible_wrong_implementation": "The specialized adapter owns a competing grammar and drops one semantic field.",
            "trigger_signals": ["specialized adapter", "canonical path", "precedence"],
            "risk_families": ["structural-contract"],
            "reusable_control": {"id": "CANON-DIVERGENCE-001", "procedure": "Compare canonical and specialized outputs for equivalent inputs."},
            "prevention_rule": "Specialized adapters must delegate semantic parsing to the canonical source.",
            "detection_rule": "Execute a divergent fixture that would expose a poorer specialized result.",
            "transfer_cases": [
                {"id": "T1", "surface": "parser-adapter", "status": "passed", "evidence": "synthetic-parser.log"},
                {"id": "T2", "surface": "provider-resolver", "status": "passed", "evidence": "synthetic-provider.log"},
            ],
        },
        "skill_changes": [
            {"role": "prevention", "skill": "delivery-controller", "status": "passed"},
            {"role": "detection", "skill": "independent-auditor", "status": "passed"},
        ],
    }


def test_systemic_learning_requires_generic_transferable_rule() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "learning.json"
        path.write_text(json.dumps(systemic_payload()), encoding="utf-8")
        proc = run_learning(path)
        assert proc.returncode == 0, proc.stdout


def test_systemic_learning_rejects_concrete_issue_reference() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        payload = systemic_payload()
        payload["generalized_learning"]["prevention_rule"] = "Special case required by Issue 123."
        path = Path(tmp) / "learning.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        proc = run_learning(path)
        assert proc.returncode == 2
        assert "issue/PR identifier" in proc.stdout


def test_implementation_only_rejection_records_non_promotion_reason() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "learning.json"
        path.write_text(json.dumps({
            "schema_version": 1,
            "classification": "implementation-only",
            "source_event": {"kind": "independent-rejection"},
            "generalized_learning": {
                "promotion_status": "not-required",
                "reason": "The defect is a local typo already covered by an existing generic rule.",
            },
        }), encoding="utf-8")
        proc = run_learning(path)
        assert proc.returncode == 0, proc.stdout


def test_genericity_gate_rejects_numbered_issue_test_filename() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "tests").mkdir()
        (root / "tests" / "test_issue_123_escape.py").write_text("def test_x(): pass\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(GENERICITY), "--skill-root", str(root)],
            text=True,
            stdout=subprocess.PIPE,
        )
        assert proc.returncode == 2
        assert "numbered issue-specific test filename" in proc.stdout
