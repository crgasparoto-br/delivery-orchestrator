#!/usr/bin/env python3
"""Single fail-closed preflight before spending an independent audit."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str], errors: list[str]) -> None:
    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
        errors.extend(lines or [f"BLOCK: validator failed: {' '.join(args)}"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--certificate", required=True)
    parser.add_argument("--artifacts-dir", required=True)
    parser.add_argument("--attack-matrix", required=True)
    parser.add_argument("--risk-saturation", required=True)
    parser.add_argument("--inherited-controls", required=True)
    parser.add_argument("--head-sha", required=True, help="Current published candidate head SHA")
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--merge-preview-sha")
    parser.add_argument("--candidate-parent-sha")
    parser.add_argument("--candidate-changed-path", action="append", default=[])
    parser.add_argument("--contract-version", required=True)
    args = parser.parse_args()

    errors: list[str] = []
    cert_args = [
        sys.executable, str(ROOT / "scripts" / "validate_handoff_certificate.py"),
        "--certificate", args.certificate,
        "--artifacts-dir", args.artifacts_dir,
        "--head-sha", args.head_sha,
        "--base-sha", args.base_sha,
        "--contract-version", args.contract_version,
    ]
    if args.merge_preview_sha is not None:
        cert_args.extend(["--merge-preview-sha", args.merge_preview_sha])
    if args.candidate_parent_sha is not None:
        cert_args.extend(["--candidate-parent-sha", args.candidate_parent_sha])
    for path in args.candidate_changed_path:
        cert_args.extend(["--candidate-changed-path", path])
    run(cert_args, errors)
    if errors:
        for error in errors:
            print(error if error.startswith("BLOCK:") else f"BLOCK: {error}")
        return 2

    try:
        cert = json.loads(Path(args.certificate).read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"BLOCK: invalid handoff certificate after validation: {exc}")
        return 2
    identity = cert.get("identity") or {}
    material_head_sha = identity.get("material_head_sha") or identity.get("head_sha")
    if not material_head_sha:
        print("BLOCK: handoff certificate lacks material head identity")
        return 2

    run([
        sys.executable, str(ROOT / "scripts" / "check_delivery_saturation.py"),
        "--attack-matrix", args.attack_matrix,
        "--risk-saturation", args.risk_saturation,
        "--inherited-controls", args.inherited_controls,
        "--head-sha", material_head_sha,
    ], errors)

    if cert.get("previous_independent_rejection"):
        directory = Path(args.artifacts_dir)
        escape = directory / "audit-escape-closure.json"
        learning = directory / "learning-closure.json"
        run([
            sys.executable, str(ROOT / "scripts" / "check_reaudit_readiness.py"),
            "--closure", str(escape),
            "--inherited-controls", args.inherited_controls,
            "--head-sha", material_head_sha,
        ], errors)
        run([
            sys.executable, str(ROOT / "scripts" / "validate_learning_closure.py"),
            "--learning-closure", str(learning),
        ], errors)

    if errors:
        for error in errors:
            print(error if error.startswith("BLOCK:") else f"BLOCK: {error}")
        return 2
    if args.head_sha != material_head_sha:
        print(f"READY: certified delivery child {args.head_sha} preserves material head {material_head_sha}")
    else:
        print("READY: certified delivery is ready for independent audit expenditure")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
