from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANONICAL = [
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
]
HEAD = "a" * 40
BASE = "b" * 40
MERGE = "c" * 40
EVIDENCE_SHA = hashlib.sha256(b"negative evidence").hexdigest()


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(script: str, *args: str):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *args], text=True, stdout=subprocess.PIPE)


def build_valid_delivery(base: Path) -> dict[str, Path]:
    issue = base / "issue.md"
    issue.write_text("- Preserve the public output value.\n", encoding="utf-8")
    snapshot = base / "specification-snapshot.json"
    closure = base / "requirement-closure.json"
    subprocess.run([
        sys.executable, str(ROOT / "scripts" / "build_specification_snapshot.py"),
        "--repository", "owner/repo", "--issue", "42", "--primary-source-id", "SRC-ISSUE",
        "--source", f"issue-body:SRC-ISSUE:{issue}", "--out", str(snapshot),
    ], check=True, stdout=subprocess.PIPE, text=True)
    subprocess.run([
        sys.executable, str(ROOT / "scripts" / "init_requirement_closure.py"),
        "--specification-snapshot", str(snapshot), "--out", str(closure),
    ], check=True, stdout=subprocess.PIPE, text=True)
    data = json.loads(closure.read_text(encoding="utf-8"))
    ids = []
    for item in data["obligations"]:
        ids.append(item["id"])
        item["disposition"] = "covered"
        item["requirement_ids"] = ["REQ-001"]
        item["rationale"] = "Mapped to a behavioral requirement."
    data["pass_c"] = {
        "status": "passed",
        "requirement_ids": ["REQ-001"],
        "obligation_ids": ids,
        "evidence": ["EV-001"],
        "rederived_without_pr_description": True,
        "reviewed_user_visible_semantics": True,
        "reviewed_producer_consumer_parity": True,
        "reviewed_all_specification_sources": True,
    }
    closure.write_text(json.dumps(data), encoding="utf-8")

    surface = "canonical-doc-surface"
    attack = base / "requirement-attack-matrix.json"
    attack.write_text(json.dumps({
        "schema_version": 1,
        "head_sha": HEAD,
        "requirements": [{
            "requirement_id": "REQ-001",
            "obligation_ids": ids,
            "risk_families": ["documentation"],
            "risk_surfaces": [{
                "risk_family": "documentation",
                "surface": surface,
                "reason": "The public contract is represented by a canonical documentation surface.",
            }],
            "plausible_wrong_implementation": "The implementation updates one visible path while leaving an equivalent path stale.",
            "positive_control": {"id": "POS-001", "status": "passed", "head_sha": HEAD, "evidence": "positive.log"},
            "negative_controls": [{
                "id": "NEG-001",
                "status": "passed",
                "head_sha": HEAD,
                "evidence_path": "negative.log",
                "evidence_sha256": EVIDENCE_SHA,
                "risk_family": "documentation",
                "surface": surface,
                "dimension": "stale-equivalent-claim",
                "failure_mode": "An equivalent canonical claim remains stale after the implementation changes.",
                "plausible_wrong_implementation": "Update only one documentation path and leave a competing current-state claim unchanged.",
                "control_type": "procedure",
                "procedure": "Search the canonical documentation surface for competing current-state claims.",
                "expected": "No contradictory current-state claim remains.",
                "observed": "The synthetic fixture contains no contradictory claim.",
                "sibling_cases": [{
                    "id": "S1", "surface": surface, "dimension": "alternate-current-claim", "status": "passed"
                }],
            }],
            "regression_controls": [{"id": "REG-001", "status": "passed", "head_sha": HEAD, "evidence": "regression.log"}],
        }],
        "uncovered_requirements": [],
    }), encoding="utf-8")
    risk = base / "risk-saturation.json"
    risk.write_text(json.dumps({
        "schema_version": 1,
        "head_sha": HEAD,
        "families": [{
            "family": family,
            "applicable": family == "documentation",
            "reason": "Behavioral fixture uses documentation family." if family == "documentation" else "Not applicable to this synthetic fixture.",
            "control_ids": ["NEG-001"] if family == "documentation" else [],
            "dimensions": [{
                "surface": surface,
                "reason": "The public contract is represented by a canonical documentation surface.",
                "control_ids": ["NEG-001"],
                "status": "passed",
            }] if family == "documentation" else [],
            "status": "passed" if family == "documentation" else "not-applicable",
        } for family in CANONICAL],
        "material_families_missing_controls": [],
    }), encoding="utf-8")
    inherited = base / "inherited-controls.json"
    inherited.write_text(json.dumps({
        "schema_version": 1, "head_sha": HEAD, "source_audits": [], "controls": [], "unresolved_controls": [],
    }), encoding="utf-8")
    return {"snapshot": snapshot, "closure": closure, "attack": attack, "risk": risk, "inherited": inherited}


def test_specification_coverage_detects_dropped_canonical_candidate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        issue = base / "issue.md"
        issue.write_text("- Preserve alpha.\n- Preserve beta.\n", encoding="utf-8")
        snapshot = base / "specification-snapshot.json"
        closure = base / "requirement-closure.json"
        subprocess.run([
            sys.executable, str(ROOT / "scripts" / "build_specification_snapshot.py"),
            "--repository", "owner/repo", "--issue", "42", "--primary-source-id", "SRC-ISSUE",
            "--source", f"issue-body:SRC-ISSUE:{issue}", "--out", str(snapshot),
        ], check=True, stdout=subprocess.PIPE, text=True)
        subprocess.run([
            sys.executable, str(ROOT / "scripts" / "init_requirement_closure.py"),
            "--specification-snapshot", str(snapshot), "--out", str(closure),
        ], check=True, stdout=subprocess.PIPE, text=True)
        data = json.loads(closure.read_text(encoding="utf-8"))
        data["obligations"] = data["obligations"][:1]
        closure.write_text(json.dumps(data), encoding="utf-8")
        proc = run("validate_specification_coverage.py", "--specification-snapshot", str(snapshot), "--requirement-closure", str(closure))
        assert proc.returncode == 2
        assert "missing from closure" in proc.stdout


def test_build_and_validate_handoff_certificate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        files = build_valid_delivery(base)
        cert = base / "handoff-ready.json"
        proc = run(
            "build_handoff_certificate.py",
            "--specification-snapshot", str(files["snapshot"]),
            "--requirement-closure", str(files["closure"]),
            "--attack-matrix", str(files["attack"]),
            "--risk-saturation", str(files["risk"]),
            "--inherited-controls", str(files["inherited"]),
            "--head-sha", HEAD, "--base-sha", BASE, "--merge-preview-sha", MERGE,
            "--contract-version", "2026-08-06.2", "--out", str(cert),
        )
        assert proc.returncode == 0, proc.stdout
        payload = json.loads(cert.read_text(encoding="utf-8"))
        assert payload["schema_version"] == 2
        assert payload["identity"]["material_head_sha"] == HEAD
        assert payload["certificate_commit_policy"]["mode"] == "result-only-child"
        assert ".audit/entregar-issue/handoff-ready.json" in payload["certificate_commit_policy"]["allowed_paths"]

        proc = run(
            "validate_handoff_certificate.py",
            "--certificate", str(cert), "--artifacts-dir", str(base),
            "--head-sha", HEAD, "--base-sha", BASE, "--merge-preview-sha", MERGE,
            "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 0, proc.stdout

        child = "d" * 40
        proc = run(
            "validate_handoff_certificate.py",
            "--certificate", str(cert), "--artifacts-dir", str(base),
            "--head-sha", child, "--base-sha", BASE, "--merge-preview-sha", "e" * 40,
            "--candidate-parent-sha", HEAD,
            "--candidate-changed-path", ".audit/entregar-issue/handoff-ready.json",
            "--candidate-changed-path", ".audit/entregar-issue/requirement-attack-matrix.json",
            "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 0, proc.stdout
        assert "result-only handoff child" in proc.stdout

        proc = run(
            "validate_handoff_certificate.py",
            "--certificate", str(cert), "--artifacts-dir", str(base),
            "--head-sha", child, "--base-sha", BASE,
            "--candidate-parent-sha", HEAD,
            "--candidate-changed-path", "server/product.ts",
            "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 2
        assert "non-handoff paths" in proc.stdout

        files["risk"].write_text(files["risk"].read_text(encoding="utf-8") + "\n", encoding="utf-8")
        proc = run(
            "validate_handoff_certificate.py",
            "--certificate", str(cert), "--artifacts-dir", str(base),
            "--head-sha", HEAD, "--base-sha", BASE, "--merge-preview-sha", MERGE,
            "--contract-version", "2026-08-06.2",
        )
        assert proc.returncode == 2
        assert "hash mismatch" in proc.stdout
