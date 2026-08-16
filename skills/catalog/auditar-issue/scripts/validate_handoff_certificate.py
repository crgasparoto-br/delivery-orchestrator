#!/usr/bin/env python3
"""Validate a handoff certificate, including result-only child publication."""
from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected object")
    return value


def normalize_repo_path(value: str) -> str:
    raw = value.replace("\\", "/").strip()
    normalized = posixpath.normpath(raw)
    if not raw or raw.startswith("/") or normalized in {".", ".."} or normalized.startswith("../"):
        raise ValueError(f"invalid repository-relative path: {value!r}")
    return normalized


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--certificate", required=True)
    parser.add_argument("--artifacts-dir", required=True)
    parser.add_argument("--head-sha", required=True, help="Current published candidate head SHA")
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--merge-preview-sha", help="Current published candidate merge preview")
    parser.add_argument("--candidate-parent-sha")
    parser.add_argument("--candidate-changed-path", action="append", default=[])
    parser.add_argument("--contract-version")
    args = parser.parse_args()
    errors: list[str] = []
    try:
        cert = load(Path(args.certificate))
    except Exception as exc:
        print(f"BLOCK: invalid handoff certificate: {exc}")
        return 2

    schema_version = cert.get("schema_version")
    if schema_version not in {1, 2} or cert.get("status") != "ready":
        errors.append("handoff certificate is not ready schema v1/v2")

    identity = cert.get("identity") or {}
    material_head = identity.get("material_head_sha") or identity.get("head_sha")
    if not material_head:
        errors.append("certificate lacks material head identity")
    if identity.get("base_sha") != args.base_sha:
        errors.append("certificate base_sha differs from candidate")

    policy = cert.get("certificate_commit_policy") or {}
    mode = policy.get("mode")
    exact_head = args.head_sha == material_head

    if mode == "result-only-child":
        if exact_head:
            material_merge = identity.get("material_merge_preview_sha") or identity.get("merge_preview_sha")
            if args.merge_preview_sha is not None and material_merge != args.merge_preview_sha:
                errors.append("certificate material merge_preview_sha differs from candidate")
        else:
            if args.candidate_parent_sha != material_head:
                errors.append("result-only child parent differs from certified material_head_sha")
            try:
                allowed = {normalize_repo_path(str(p)) for p in policy.get("allowed_paths", [])}
                changed = {normalize_repo_path(str(p)) for p in args.candidate_changed_path}
            except ValueError as exc:
                errors.append(str(exc))
                allowed = set()
                changed = set()
            if not allowed:
                errors.append("result-only child policy lacks allowed_paths")
            if not changed:
                errors.append("result-only child validation requires candidate changed paths")
            disallowed = sorted(changed - allowed)
            if disallowed:
                errors.append("result-only child contains non-handoff paths: " + ", ".join(disallowed))
    else:
        # Legacy schema v1 / exact-head mode.
        if identity.get("head_sha") != args.head_sha:
            errors.append("certificate head_sha differs from candidate")
        if args.merge_preview_sha is not None and identity.get("merge_preview_sha") != args.merge_preview_sha:
            errors.append("certificate merge_preview_sha differs from candidate")

    if args.contract_version and cert.get("contract_version") != args.contract_version:
        errors.append("certificate contract_version differs from auditor contract")
    producer = cert.get("producer") or {}
    if producer.get("skill") != "entregar-issue" or len(str(producer.get("skill_sha256") or "")) != 64:
        errors.append("certificate lacks delivery skill provenance")

    artifacts_dir = Path(args.artifacts_dir).resolve()
    artifacts = cert.get("artifacts") or {}
    required = {
        "specification_snapshot", "requirement_closure", "requirement_attack_matrix",
        "risk_saturation", "inherited_controls",
    }
    if cert.get("previous_independent_rejection"):
        required.update({"audit_escape_closure", "learning_closure"})
    for key in sorted(required):
        item = artifacts.get(key)
        if not isinstance(item, dict):
            errors.append(f"certificate lacks artifact {key}")
            continue
        path = artifacts_dir / str(item.get("name") or "")
        if not path.is_file():
            errors.append(f"certified artifact {key} is missing")
            continue
        if sha256(path) != item.get("sha256"):
            errors.append(f"certified artifact {key} hash mismatch")

    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2
    if mode == "result-only-child" and not exact_head:
        print(f"READY: result-only handoff child is bound to material head {material_head}")
    else:
        print("READY: handoff certificate matches candidate identity and artifact hashes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
