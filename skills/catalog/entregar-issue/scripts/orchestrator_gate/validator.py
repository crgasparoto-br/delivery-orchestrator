from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .evidence_validation import validate_evidence
from .identity import audit_command_matches
from .packet_validation import validate_packet
from .requirement_closure_validation import validate_requirement_closure
from .remote_validation import validate_remote
from .risk_validation import validate_risk
from .schema_validation import validate_against_schema
from .state_validation import validate_state
from .utils import git, text


def validate(data: dict[str, Any], evidence_path: Path, *, allow_fixture: bool = False) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    skill_root = Path(__file__).resolve().parents[2]
    validate_against_schema(data, skill_root / "schemas" / "evidence.schema.json", "evidence", errors)
    if data.get("schema_version") != 9:
        errors.append("evidence schema_version must be 9")
    repository = text(data.get("repository"), "repository", errors, 3)
    if not isinstance(data.get("issue"), int) or data.get("issue") <= 0:
        errors.append("issue must be a positive integer")
    repo = Path(str(data.get("repository_path", ""))).resolve()
    if not (repo / ".git").exists():
        errors.append(f"repository_path is not a Git repository: {repo}")
    head = text(data.get("head_sha"), "head_sha", errors, 7)
    if data.get("head_sha_after") != head:
        errors.append("head_sha_after must equal frozen head_sha")
    if (repo / ".git").exists() and head:
        try:
            if git(repo, "rev-parse", "HEAD") != head:
                errors.append("local HEAD differs from frozen SHA")
            if git(repo, "status", "--porcelain=v1"):
                errors.append("repository working tree is dirty")
        except RuntimeError as exc:
            errors.append(f"Git validation failed: {exc}")

    packet, metadata, context_files, coverage = validate_packet(data, errors)
    risk = validate_risk(data, packet, evidence_path.parent, errors)
    state = validate_state(data, evidence_path.parent, metadata, errors)
    if state:
        validate_against_schema(state, skill_root / "schemas" / "orchestration-state.schema.json", "orchestration state", errors)
    remote = validate_remote(data, repo, evidence_path.parent, metadata, risk, errors, allow_fixture=allow_fixture)
    if remote:
        validate_against_schema(remote, skill_root / "schemas" / "remote-gate.schema.json", "remote gate", errors)
    counts = validate_evidence(data, packet, context_files, risk, evidence_path.parent, errors)
    closure_counts = validate_requirement_closure(data, evidence_path.parent, errors)

    if state and remote:
        if state.get("merge_preview_sha") != remote.get("merge_preview_sha"):
            errors.append("orchestration state merge_preview_sha differs from remote gate")
        if state.get("base_sha") != remote.get("base_sha"):
            errors.append("orchestration state base_sha differs from remote gate")

    state_artifacts = state.get("current_artifacts") or {} if isinstance(state, dict) else {}
    expected_artifact_paths = {
        "packet-manifest": packet / "manifest.json",
        "pass-b-plan": Path(str(((data.get("passes") or {}).get("pass_b") or {}).get("plan_path", ""))).resolve(),
        "requirement-closure": Path(str((data.get("requirement_closure") or {}).get("path", ""))).resolve(),
        "remote-gate": Path(str((data.get("remote_gate") or {}).get("snapshot_path", ""))).resolve(),
    }
    for name, expected_path in expected_artifact_paths.items():
        item = state_artifacts.get(name) if isinstance(state_artifacts, dict) else None
        if isinstance(item, dict):
            if Path(str(item.get("path", ""))).resolve() != expected_path:
                errors.append(f"orchestration artifact {name} path differs from evidence")
            if remote and item.get("merge_preview_sha") != remote.get("merge_preview_sha"):
                errors.append(f"orchestration artifact {name} merge preview differs from remote gate")
            if metadata and item.get("base_sha") != metadata.get("base_sha"):
                errors.append(f"orchestration artifact {name} base SHA differs from packet")

    handoff = data.get("handoff") or {}
    if handoff.get("independent_audit_required") is not True or handoff.get("same_conversation_prohibited") is not True:
        errors.append("handoff must require independent audit in a new conversation")
    instruction = text(handoff.get("new_conversation_instruction"), "handoff.new_conversation_instruction", errors, 30)
    command = text(handoff.get("audit_command"), "handoff.audit_command", errors, 20)
    if "nova conversa" not in instruction.lower() and "new conversation" not in instruction.lower():
        errors.append("handoff must explicitly require a new conversation")
    if not audit_command_matches(command, repository, int(data.get("issue") or 0), head):
        errors.append("handoff audit command must contain the exact repository, explicit issue token and exact SHA")

    report = {
        "schema_version": 4,
        "evidence_file": str(evidence_path),
        "head_sha": head,
        "base_sha": metadata.get("base_sha") if isinstance(metadata, dict) else "",
        "merge_preview_sha": remote.get("merge_preview_sha") if isinstance(remote, dict) else "",
        "orchestration_cycle": state.get("cycle") if isinstance(state, dict) else None,
        "result": "passed" if not errors else "failed",
        "errors": errors,
        "warnings": warnings,
        "counts": {
            **counts,
            **closure_counts,
            "runtime_context_files": len(context_files),
            "reverse_callers": coverage.get("reverse_callers", 0) if isinstance(coverage, dict) else 0,
            "remote_workflows": len(remote.get("workflows") or []) if isinstance(remote, dict) else 0,
            "remote_artifacts": len(remote.get("artifacts") or []) if isinstance(remote, dict) else 0,
        },
    }
    return report
