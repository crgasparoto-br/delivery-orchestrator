#!/usr/bin/env python3
"""Producer-side terminal guard for a published result-only handoff child.

This validator intentionally requires a *published* child commit. It complements
validate_handoff_certificate.py, which can also validate the material head before
publication. Delivery must run this guard with freshly re-read remote metadata
immediately before returning or inviting an independent audit.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CERT_REPO_PATH = ".audit/entregar-issue/handoff-ready.json"


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--certificate", required=True)
    parser.add_argument("--artifacts-dir", required=True)
    parser.add_argument("--material-head-sha", required=True)
    parser.add_argument("--published-head-sha", required=True)
    parser.add_argument("--published-parent-sha", required=True)
    parser.add_argument("--published-changed-path", action="append", default=[])
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--contract-version")
    parser.add_argument("--certificate-repo-path", default=DEFAULT_CERT_REPO_PATH)
    args = parser.parse_args()

    errors: list[str] = []
    cert_path = Path(args.certificate).resolve()
    try:
        cert = load(cert_path)
    except Exception as exc:
        print(f"BLOCK: invalid handoff certificate: {exc}")
        return 2

    identity = cert.get("identity") or {}
    material = identity.get("material_head_sha") or identity.get("head_sha")
    policy = cert.get("certificate_commit_policy") or {}

    if material != args.material_head_sha:
        errors.append("certificate material_head_sha differs from terminal material head")
    if policy.get("mode") != "result-only-child":
        errors.append("terminal handoff requires result-only-child policy")
    if args.published_head_sha == args.material_head_sha:
        errors.append("handoff child was not published; remote head is still the material head")
    if args.published_parent_sha != args.material_head_sha:
        errors.append("published handoff head is not a direct child of the material head")
    changed = {str(path).replace("\\", "/").strip() for path in args.published_changed_path if str(path).strip()}
    if args.certificate_repo_path not in changed:
        errors.append("published handoff commit does not contain handoff-ready.json")

    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2

    cmd = [
        sys.executable, str(ROOT / "scripts" / "validate_handoff_certificate.py"),
        "--certificate", str(cert_path),
        "--artifacts-dir", str(Path(args.artifacts_dir).resolve()),
        "--head-sha", args.published_head_sha,
        "--base-sha", args.base_sha,
        "--candidate-parent-sha", args.published_parent_sha,
    ]
    for path in sorted(changed):
        cmd.extend(["--candidate-changed-path", path])
    if args.contract_version:
        cmd.extend(["--contract-version", args.contract_version])
    proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        print(proc.stdout.strip() or "BLOCK: handoff certificate validation failed")
        return 2


    print(
        "READY: terminal handoff published "
        f"{args.published_head_sha} for material head {args.material_head_sha}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
