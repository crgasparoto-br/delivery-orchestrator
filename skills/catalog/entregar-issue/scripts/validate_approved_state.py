#!/usr/bin/env python3
"""Revalidate a signed external approval against current local and remote identity."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import jsonschema

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from orchestrator_gate.audit_signature import (
    load_registry,
    sha256_file,
    validate_registry_boundary,
    verify_report_signature,
)
from orchestrator_gate.remote_recheck import live_recheck


def git(repo: Path, *args: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def load_json(path: Path, label: str, errors: list[str]) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size == 0:
        errors.append(f"{label} is missing or empty: {path}")
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"{label} is invalid JSON: {exc}")
        return {}
    if not isinstance(value, dict):
        errors.append(f"{label} must be a JSON object")
        return {}
    return value


def validate_schema(value: dict[str, Any], schema_path: Path, label: str, errors: list[str]) -> None:
    schema = load_json(schema_path, f"{label} schema", errors)
    if not schema:
        return
    for item in sorted(jsonschema.Draft202012Validator(schema).iter_errors(value), key=lambda err: list(err.path)):
        location = ".".join(str(part) for part in item.path) or "root"
        errors.append(f"{label} schema {location}: {item.message}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("state_file")
    parser.add_argument("--skip-remote-recheck", action="store_true")
    args = parser.parse_args()
    state_path = Path(args.state_file).resolve()
    errors: list[str] = []
    state = load_json(state_path, "orchestration state", errors)
    schema_dir = Path(__file__).resolve().parents[1] / "schemas"
    if state:
        validate_schema(state, schema_dir / "orchestration-state.schema.json", "orchestration state", errors)
    if state.get("state") != "aprovado":
        errors.append("orchestration state is not aprovado")
    external = state.get("external_audit")
    if not isinstance(external, dict):
        errors.append("approved state lacks external_audit")
        external = {}

    report_path = Path(str(external.get("report_path") or "")).resolve()
    registry_path = Path(str(external.get("trusted_auditors_path") or "")).resolve()
    report = load_json(report_path, "external audit report", errors)
    registry, registry_errors = load_registry(registry_path)
    errors.extend(registry_errors)
    if report:
        validate_schema(report, schema_dir / "external-audit.schema.json", "external audit report", errors)
    if registry:
        validate_schema(registry, schema_dir / "trusted-auditors.schema.json", "trusted auditor registry", errors)
    if report_path.is_file() and external.get("report_sha256") != sha256_file(report_path):
        errors.append("external audit report hash differs from approved state")
    if registry_path.is_file() and external.get("trusted_auditors_sha256") != sha256_file(registry_path):
        errors.append("trusted auditor registry hash differs from approved state")

    if report and registry:
        signature_errors, auditor = verify_report_signature(report, registry, str(state.get("repository") or ""))
        errors.extend(signature_errors)
        if (external.get("trusted_auditor") or {}).get("key_id") != (auditor or {}).get("key_id"):
            errors.append("approved state trusted auditor differs from the signed report")
    repository_path = Path(str(state.get("repository_path") or "")).resolve()
    errors.extend(validate_registry_boundary(
        registry_path,
        repository_path=repository_path if str(state.get("repository_path") or "") else None,
        base_sha=str(state.get("base_sha") or ""),
        head_sha=str(state.get("head_sha") or ""),
    ))

    for field in ("repository", "issue", "base_ref", "head_sha", "base_sha", "merge_preview_sha"):
        if report.get(field) != state.get(field):
            errors.append(f"external audit {field} differs from approved state")
    for field in ("head_sha", "base_sha", "merge_preview_sha"):
        if report.get(f"{field}_after") != state.get(field):
            errors.append(f"external audit {field}_after differs from approved state")
    if report.get("orchestration_cycle") != state.get("cycle"):
        errors.append("external audit orchestration_cycle differs from approved state")
    if report.get("report_id") != external.get("report_id"):
        errors.append("approved state report_id differs from report")
    if report.get("signature") != external.get("signature"):
        errors.append("approved state signature differs from report")
    if report.get("verdict") != "approved" or report.get("findings") or report.get("limitations"):
        errors.append("approved report contains a non-approved result, findings or limitations")
    if any(
        isinstance(item, dict) and item.get("status") != "resolved-and-reverified"
        for item in state.get("findings") or []
    ):
        errors.append("approved state contains unresolved findings")
    history = state.get("audit_history") or []
    if not isinstance(history, list) or not history:
        errors.append("approved state audit_history is empty")
    elif history[-1] != external:
        errors.append("approved state external_audit is not the latest audit history record")

    if not (repository_path / ".git").exists():
        errors.append("approved state repository_path is not an exact Git repository")
    else:
        rc, current_head, err = git(repository_path, "rev-parse", "HEAD")
        if rc != 0 or current_head != state.get("head_sha"):
            errors.append(err or "local HEAD differs from approved head SHA")
        rc, current_base, err = git(repository_path, "rev-parse", str(state.get("base_ref") or ""))
        if rc != 0 or current_base != state.get("base_sha"):
            errors.append(err or "local base ref differs from approved base SHA")
        rc, dirty, err = git(repository_path, "status", "--porcelain=v1")
        if rc != 0 or dirty:
            errors.append(err or "approved repository working tree is not clean")

    artifacts = state.get("current_artifacts") or {}
    if not isinstance(artifacts, dict):
        errors.append("approved state current_artifacts must be an object")
        artifacts = {}
    for required in ("packet-manifest", "pass-b-plan", "remote-gate"):
        if required not in artifacts:
            errors.append(f"approved state lacks current artifact: {required}")
    for name, item in artifacts.items():
        if not isinstance(item, dict):
            errors.append(f"approved artifact {name} is invalid")
            continue
        artifact_path = Path(str(item.get("path") or "")).resolve()
        if not artifact_path.is_file() or artifact_path.stat().st_size == 0:
            errors.append(f"approved artifact {name} is missing or empty")
            continue
        if item.get("sha256") != sha256_file(artifact_path):
            errors.append(f"approved artifact {name} hash mismatch")
        for field in ("head_sha", "base_sha", "merge_preview_sha"):
            if item.get(field) != state.get(field):
                errors.append(f"approved artifact {name} {field} mismatch")
        if item.get("cycle") != state.get("cycle"):
            errors.append(f"approved artifact {name} cycle mismatch")

    if args.skip_remote_recheck:
        if os.environ.get("ORCHESTRATOR_TEST_MODE") != "1":
            errors.append("--skip-remote-recheck is allowed only with ORCHESTRATOR_TEST_MODE=1")
    else:
        remote_item = artifacts.get("remote-gate") if isinstance(artifacts, dict) else None
        remote_path = Path(str((remote_item or {}).get("path") or "")).resolve()
        snapshot = load_json(remote_path, "approved remote gate snapshot", errors)
        if snapshot:
            remote_errors, _ = live_recheck({
                "repository": state.get("repository"),
                "issue": state.get("issue"),
                "head_sha": state.get("head_sha"),
                "remote_gate": {"pull_request": state.get("pull_request")},
            }, snapshot)
            errors.extend(remote_errors)

    if errors:
        print("FAIL: approved state rejected")
        for error in errors:
            print(f"- {error}")
        return 1
    print("PASS: signed external approval is current and verifiable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
