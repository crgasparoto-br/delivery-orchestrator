#!/usr/bin/env python3
"""Connector-native preflight for immutable GitHub snapshots when raw bytes cannot be mounted.

This is a fallback, not a replacement for check_delivery_preflight.py. It validates that
connector-derived semantic observations are bound to immutable Git object identities and
to the same result-only delivery snapshot described by the handoff certificate.
"""
from __future__ import annotations

import argparse
import json
import posixpath
import re
from pathlib import Path

SHA40 = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
REQUIRED_ARTIFACTS = {
    "specification_snapshot",
    "requirement_closure",
    "requirement_attack_matrix",
    "risk_saturation",
    "inherited_controls",
}
CANONICAL_RISKS = {
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
}


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected object: {path}")
    return value


def normalize_repo_path(value: str) -> str:
    raw = value.replace("\\", "/").strip()
    normalized = posixpath.normpath(raw)
    if not raw or raw.startswith("/") or normalized in {".", ".."} or normalized.startswith("../"):
        raise ValueError(f"invalid repository-relative path: {value!r}")
    return normalized


def require_bool(semantic: dict, key: str, label: str, errors: list[str]) -> None:
    if semantic.get(key) is not True:
        errors.append(f"{label} semantic proof lacks {key}=true")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--certificate", required=True)
    parser.add_argument("--connector-manifest", required=True)
    parser.add_argument("--contract-version", required=True)
    args = parser.parse_args()

    try:
        cert = load(Path(args.certificate))
        manifest = load(Path(args.connector_manifest))
    except Exception as exc:
        print(f"BLOCK: invalid connector preflight input: {exc}")
        return 2

    errors: list[str] = []
    limitations: list[str] = []

    if cert.get("schema_version") not in {1, 2} or cert.get("status") != "ready":
        errors.append("handoff certificate is not ready schema v1/v2")
    if cert.get("contract_version") != args.contract_version:
        errors.append("certificate contract_version differs from auditor contract")
    producer = cert.get("producer") or {}
    if producer.get("skill") != "entregar-issue" or len(str(producer.get("skill_sha256") or "")) != 64:
        errors.append("certificate lacks delivery skill provenance")

    identity = cert.get("identity") or {}
    material_head = identity.get("material_head_sha") or identity.get("head_sha")
    if not material_head or not SHA40.fullmatch(str(material_head)):
        errors.append("certificate lacks valid material head identity")

    published_head = str(manifest.get("published_head_sha") or "")
    base_sha = str(manifest.get("base_sha") or "")
    candidate_parent = str(manifest.get("candidate_parent_sha") or "")
    published_tree = str(manifest.get("published_tree_sha") or "")
    if not SHA40.fullmatch(published_head):
        errors.append("connector manifest lacks valid published_head_sha")
    if not SHA40.fullmatch(base_sha):
        errors.append("connector manifest lacks valid base_sha")
    if not SHA40.fullmatch(published_tree):
        errors.append("connector manifest lacks valid published_tree_sha")
    if identity.get("base_sha") != base_sha:
        errors.append("certificate base_sha differs from connector snapshot")

    policy = cert.get("certificate_commit_policy") or {}
    mode = policy.get("mode")
    exact_head = published_head == material_head
    changed_paths: set[str] = set()
    try:
        changed_paths = {normalize_repo_path(str(p)) for p in manifest.get("candidate_changed_paths") or []}
    except ValueError as exc:
        errors.append(str(exc))

    if mode == "result-only-child" and not exact_head:
        if candidate_parent != material_head:
            errors.append("result-only child parent differs from certified material_head_sha")
        try:
            allowed = {normalize_repo_path(str(p)) for p in policy.get("allowed_paths") or []}
        except ValueError as exc:
            errors.append(str(exc))
            allowed = set()
        if not allowed:
            errors.append("result-only child policy lacks allowed_paths")
        if not changed_paths:
            errors.append("connector manifest requires candidate changed paths")
        disallowed = sorted(changed_paths - allowed)
        if disallowed:
            errors.append("result-only child contains non-handoff paths: " + ", ".join(disallowed))
    elif mode != "result-only-child":
        if identity.get("head_sha") != published_head:
            errors.append("certificate head_sha differs from connector snapshot")

    artifacts = cert.get("artifacts") or {}
    required = set(REQUIRED_ARTIFACTS)
    if cert.get("previous_independent_rejection"):
        required.update({"audit_escape_closure", "learning_closure"})

    manifest_artifacts = manifest.get("artifacts") or {}
    if not isinstance(manifest_artifacts, dict):
        errors.append("connector manifest artifacts must be an object")
        manifest_artifacts = {}

    for key in sorted(required):
        cert_item = artifacts.get(key)
        remote_item = manifest_artifacts.get(key)
        if not isinstance(cert_item, dict):
            errors.append(f"certificate lacks artifact {key}")
            continue
        if not isinstance(remote_item, dict):
            errors.append(f"connector manifest lacks artifact {key}")
            continue
        expected_name = str(cert_item.get("name") or "")
        remote_path = str(remote_item.get("path") or "")
        if not remote_path.endswith("/" + expected_name) and remote_path != expected_name:
            errors.append(f"connector artifact {key} path does not match certificate name")
        blob_sha = str(remote_item.get("git_blob_sha") or "")
        size = remote_item.get("size")
        if not SHA40.fullmatch(blob_sha):
            errors.append(f"connector artifact {key} lacks immutable git_blob_sha")
        if not isinstance(size, int) or size < 0:
            errors.append(f"connector artifact {key} lacks valid byte size")
        if remote_item.get("object_type") != "blob":
            errors.append(f"connector artifact {key} is not a Git blob")
        if remote_item.get("read_scope") != "complete-searchable-object":
            limitations.append(f"connector artifact {key} was not read/searchable as a complete object")
        semantic = remote_item.get("semantic")
        if not isinstance(semantic, dict):
            errors.append(f"connector artifact {key} lacks semantic proof")
            continue

        if key in {"requirement_attack_matrix", "risk_saturation", "inherited_controls"}:
            if semantic.get("head_sha") != material_head:
                errors.append(f"connector artifact {key} head_sha differs from material head")

        if key == "requirement_attack_matrix":
            require_bool(semantic, "uncovered_requirements_empty", key, errors)
            require_bool(semantic, "all_requirements_have_plausible_wrong_implementation", key, errors)
            require_bool(semantic, "all_positive_controls_passed_on_material_head", key, errors)
            require_bool(semantic, "all_negative_controls_passed_on_material_head", key, errors)
            require_bool(semantic, "all_regression_controls_passed_on_material_head", key, errors)
        elif key == "risk_saturation":
            require_bool(semantic, "all_canonical_families_present", key, errors)
            require_bool(semantic, "all_applicable_families_passed_with_controls", key, errors)
            require_bool(semantic, "material_families_missing_controls_empty", key, errors)
            families = set(semantic.get("canonical_families") or [])
            if families != CANONICAL_RISKS:
                errors.append("risk_saturation semantic proof canonical family set differs from auditor contract")
        elif key == "inherited_controls":
            require_bool(semantic, "unresolved_controls_empty", key, errors)
            require_bool(semantic, "all_controls_passed_on_material_head", key, errors)
        elif key == "audit_escape_closure":
            require_bool(semantic, "all_escapes_passed", key, errors)
            require_bool(semantic, "all_escapes_have_class", key, errors)
            require_bool(semantic, "all_escapes_have_plausible_wrong_implementation", key, errors)
            require_bool(semantic, "all_escapes_have_two_passed_siblings", key, errors)
            require_bool(semantic, "all_escapes_have_prevention_and_detection_evidence", key, errors)
        elif key == "learning_closure":
            require_bool(semantic, "learning_closed", key, errors)
        elif key == "specification_snapshot":
            require_bool(semantic, "issue_and_identity_match", key, errors)
        elif key == "requirement_closure":
            require_bool(semantic, "all_required_requirements_closed", key, errors)

    if limitations:
        for limitation in limitations:
            print(f"LIMITATION: {limitation}")
        return 3
    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2

    print(
        "READY: connector-native immutable Git snapshot and semantic delivery preflight are valid; "
        f"material head {material_head}, published head {published_head}, tree {published_tree}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
