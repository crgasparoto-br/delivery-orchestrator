from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_connector_preflight.py"
MATERIAL = "a" * 40
PUBLISHED = "b" * 40
BASE = "c" * 40
TREE = "d" * 40
CANONICAL = [
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
]


def run(cert: Path, manifest: Path):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--certificate", str(cert), "--connector-manifest", str(manifest),
         "--contract-version", "2026-08-06.2"],
        text=True, stdout=subprocess.PIPE,
    )


def artifact(path: str, semantic: dict):
    return {
        "path": path,
        "git_blob_sha": "e" * 40,
        "size": 123,
        "object_type": "blob",
        "read_scope": "complete-searchable-object",
        "semantic": semantic,
    }


def make(tmp: Path):
    artifacts = {
        "specification_snapshot": {"name": "specification-snapshot.json", "sha256": "1" * 64},
        "requirement_closure": {"name": "requirement-closure.json", "sha256": "2" * 64},
        "requirement_attack_matrix": {"name": "requirement-attack-matrix.json", "sha256": "3" * 64},
        "risk_saturation": {"name": "risk-saturation.json", "sha256": "4" * 64},
        "inherited_controls": {"name": "inherited-controls.json", "sha256": "5" * 64},
    }
    allowed = [f".audit/entregar-issue/{item['name']}" for item in artifacts.values()] + [".audit/entregar-issue/handoff-ready.json"]
    cert = tmp / "handoff-ready.json"
    cert.write_text(json.dumps({
        "schema_version": 2,
        "status": "ready",
        "identity": {"head_sha": MATERIAL, "material_head_sha": MATERIAL, "base_sha": BASE},
        "certificate_commit_policy": {"mode": "result-only-child", "allowed_paths": allowed},
        "contract_version": "2026-08-06.2",
        "producer": {"skill": "entregar-issue", "skill_sha256": "f" * 64},
        "artifacts": artifacts,
        "previous_independent_rejection": False,
    }), encoding="utf-8")

    apath = lambda name: f".audit/entregar-issue/{name}"
    manifest = tmp / "connector-preflight-manifest.json"
    manifest.write_text(json.dumps({
        "published_head_sha": PUBLISHED,
        "published_tree_sha": TREE,
        "base_sha": BASE,
        "candidate_parent_sha": MATERIAL,
        "candidate_changed_paths": allowed,
        "artifacts": {
            "specification_snapshot": artifact(apath("specification-snapshot.json"), {"issue_and_identity_match": True}),
            "requirement_closure": artifact(apath("requirement-closure.json"), {"all_required_requirements_closed": True}),
            "requirement_attack_matrix": artifact(apath("requirement-attack-matrix.json"), {
                "head_sha": MATERIAL,
                "uncovered_requirements_empty": True,
                "all_requirements_have_plausible_wrong_implementation": True,
                "all_positive_controls_passed_on_material_head": True,
                "all_negative_controls_passed_on_material_head": True,
                "all_regression_controls_passed_on_material_head": True,
            }),
            "risk_saturation": artifact(apath("risk-saturation.json"), {
                "head_sha": MATERIAL,
                "all_canonical_families_present": True,
                "canonical_families": CANONICAL,
                "all_applicable_families_passed_with_controls": True,
                "material_families_missing_controls_empty": True,
            }),
            "inherited_controls": artifact(apath("inherited-controls.json"), {
                "head_sha": MATERIAL,
                "unresolved_controls_empty": True,
                "all_controls_passed_on_material_head": True,
            }),
        },
    }), encoding="utf-8")
    return cert, manifest


def test_connector_preflight_accepts_immutable_snapshot():
    with tempfile.TemporaryDirectory() as d:
        cert, manifest = make(Path(d))
        proc = run(cert, manifest)
        assert proc.returncode == 0, proc.stdout
        assert "connector-native immutable Git snapshot" in proc.stdout


def test_connector_preflight_rejects_product_path_in_result_only_child():
    with tempfile.TemporaryDirectory() as d:
        cert, manifest = make(Path(d))
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["candidate_changed_paths"].append("apps/api/src/product.ts")
        manifest.write_text(json.dumps(data), encoding="utf-8")
        proc = run(cert, manifest)
        assert proc.returncode == 2
        assert "non-handoff paths" in proc.stdout


def test_connector_preflight_returns_limitation_when_object_is_not_complete_searchable():
    with tempfile.TemporaryDirectory() as d:
        cert, manifest = make(Path(d))
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["artifacts"]["requirement_attack_matrix"]["read_scope"] = "truncated-snippet"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        proc = run(cert, manifest)
        assert proc.returncode == 3
        assert "LIMITATION:" in proc.stdout
