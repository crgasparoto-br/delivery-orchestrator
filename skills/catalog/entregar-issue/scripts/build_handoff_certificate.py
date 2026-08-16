#!/usr/bin/env python3
"""Build a tamper-evident handoff certificate after delivery readiness gates pass.

The certificate is bound to the *material* candidate SHA. When persisted in the
repository, it is expected to live in a direct result-only child commit whose
changed paths are explicitly allow-listed by the certificate. This avoids the
impossible self-reference of embedding a commit SHA inside a file that itself
changes that commit SHA.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO_DIR = ".audit/entregar-issue"
DEFAULT_CERT_PATH = f"{DEFAULT_REPO_DIR}/handoff-ready.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def skill_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts or ".pytest_cache" in path.parts:
            continue
        rel = path.relative_to(root).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def run(args: list[str]) -> list[str]:
    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        raise RuntimeError(proc.stdout.strip() or "validator failed")
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def normalize_repo_path(value: str) -> str:
    raw = value.replace("\\", "/").strip()
    normalized = posixpath.normpath(raw)
    if not raw or raw.startswith("/") or normalized in {".", ".."} or normalized.startswith("../"):
        raise ValueError(f"invalid repository-relative path: {value!r}")
    return normalized


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--specification-snapshot", required=True)
    parser.add_argument("--requirement-closure", required=True)
    parser.add_argument("--attack-matrix", required=True)
    parser.add_argument("--risk-saturation", required=True)
    parser.add_argument("--inherited-controls", required=True)
    parser.add_argument("--audit-escape-closure")
    parser.add_argument("--learning-closure")
    parser.add_argument("--previous-independent-rejection", action="store_true")
    parser.add_argument("--head-sha", required=True, help="Material candidate SHA, before the result-only handoff commit")
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--merge-preview-sha", help="Merge preview for the material candidate SHA")
    parser.add_argument("--contract-version", required=True)
    parser.add_argument("--artifact-repo-dir", default=DEFAULT_REPO_DIR)
    parser.add_argument("--certificate-repo-path", default=DEFAULT_CERT_PATH)
    parser.add_argument("--allow-result-path", action="append", default=[])
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    files = {
        "specification_snapshot": Path(args.specification_snapshot).resolve(),
        "requirement_closure": Path(args.requirement_closure).resolve(),
        "requirement_attack_matrix": Path(args.attack_matrix).resolve(),
        "risk_saturation": Path(args.risk_saturation).resolve(),
        "inherited_controls": Path(args.inherited_controls).resolve(),
    }
    if args.audit_escape_closure:
        files["audit_escape_closure"] = Path(args.audit_escape_closure).resolve()
    if args.learning_closure:
        files["learning_closure"] = Path(args.learning_closure).resolve()

    if args.previous_independent_rejection and "learning_closure" not in files:
        print("BLOCK: previous independent rejection requires learning-closure.json")
        return 2

    try:
        run([
            sys.executable, str(ROOT / "scripts" / "validate_specification_coverage.py"),
            "--specification-snapshot", str(files["specification_snapshot"]),
            "--requirement-closure", str(files["requirement_closure"]),
        ])
        handoff_args = [
            sys.executable, str(ROOT / "scripts" / "validate_handoff_readiness.py"),
            "--requirement-closure", str(files["requirement_closure"]),
            "--attack-matrix", str(files["requirement_attack_matrix"]),
            "--risk-saturation", str(files["risk_saturation"]),
            "--inherited-controls", str(files["inherited_controls"]),
        ]
        if args.previous_independent_rejection:
            handoff_args.append("--previous-independent-rejection")
        if "audit_escape_closure" in files:
            handoff_args.extend(["--audit-escape-closure", str(files["audit_escape_closure"])])
        run(handoff_args)
        if "learning_closure" in files:
            run([
                sys.executable, str(ROOT / "scripts" / "validate_learning_closure.py"),
                "--learning-closure", str(files["learning_closure"]),
            ])
    except Exception as exc:
        print(f"BLOCK: handoff certificate not created: {exc}")
        return 2

    for name, path in files.items():
        if not path.is_file():
            print(f"BLOCK: missing artifact {name}: {path}")
            return 2

    matrix = json.loads(files["requirement_attack_matrix"].read_text(encoding="utf-8"))
    inherited = json.loads(files["inherited_controls"].read_text(encoding="utf-8"))
    if matrix.get("head_sha") != args.head_sha or inherited.get("head_sha") != args.head_sha:
        print("BLOCK: readiness artifacts are not bound to material candidate head_sha")
        return 2

    try:
        artifact_repo_dir = normalize_repo_path(args.artifact_repo_dir)
        certificate_repo_path = normalize_repo_path(args.certificate_repo_path)
        allowed_paths = {certificate_repo_path}
        for path in files.values():
            allowed_paths.add(normalize_repo_path(posixpath.join(artifact_repo_dir, path.name)))
        for value in args.allow_result_path:
            allowed_paths.add(normalize_repo_path(value))
    except ValueError as exc:
        print(f"BLOCK: {exc}")
        return 2

    validators = [
        ROOT / "scripts" / "validate_specification_coverage.py",
        ROOT / "scripts" / "validate_handoff_readiness.py",
        ROOT / "scripts" / "validate_requirement_attack_matrix.py",
        ROOT / "scripts" / "validate_risk_saturation.py",
        ROOT / "scripts" / "validate_inherited_controls.py",
        ROOT / "scripts" / "validate_learning_closure.py",
    ]
    payload = {
        "schema_version": 2,
        "status": "ready",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "identity": {
            # head_sha is retained as a compatibility alias for material_head_sha.
            "head_sha": args.head_sha,
            "material_head_sha": args.head_sha,
            "base_sha": args.base_sha,
            "merge_preview_sha": args.merge_preview_sha,
            "material_merge_preview_sha": args.merge_preview_sha,
        },
        "certificate_commit_policy": {
            "mode": "result-only-child",
            "allowed_paths": sorted(allowed_paths),
        },
        "contract_version": args.contract_version,
        "producer": {
            "skill": "entregar-issue",
            "skill_sha256": skill_hash(ROOT),
        },
        "validators": {path.name: sha256(path) for path in validators},
        "artifacts": {
            name: {"name": path.name, "sha256": sha256(path)} for name, path in files.items()
        },
        "previous_independent_rejection": bool(args.previous_independent_rejection),
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"READY: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
