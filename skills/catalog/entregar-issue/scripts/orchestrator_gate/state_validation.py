from __future__ import annotations

from pathlib import Path
from typing import Any

from .utils import is_nonempty, load_json, resolve, sha256_file


def validate_state(data: dict[str, Any], evidence_dir: Path, metadata: dict, errors: list[str]) -> dict:
    ref = data.get("orchestration_state")
    if not isinstance(ref, dict):
        errors.append("orchestration_state reference missing")
        return {}
    path = resolve(evidence_dir, str(ref.get("path", "")))
    state = load_json(path, "orchestration state", errors)
    if state and ref.get("sha256") != sha256_file(path):
        errors.append("orchestration state hash mismatch")
    if state.get("schema_version") != 3:
        errors.append("orchestration state schema_version must be 3")
    for field in ("repository", "issue", "base_ref", "head_sha"):
        if state.get(field) != data.get(field):
            errors.append(f"orchestration state {field} differs from evidence")
    if metadata and state.get("base_sha") != metadata.get("base_sha"):
        errors.append("orchestration state base_sha differs from packet")
    if state.get("state") not in {"verificado", "pronto-para-auditoria-independente"}:
        errors.append("orchestration state must be verificado or pronto-para-auditoria-independente")
    if not isinstance(state.get("implementation_context_id"), str) or len(state.get("implementation_context_id", "")) < 8:
        errors.append("orchestration state implementation_context_id is missing")
    if state.get("external_audit") is not None:
        errors.append("internal gate state must not already contain an external approval")
    if not isinstance(state.get("audit_history"), list) or not isinstance(state.get("invalidated_audits"), list):
        errors.append("orchestration state audit history is invalid")
    if not isinstance(state.get("cycle"), int) or state.get("cycle") < 1:
        errors.append("orchestration state cycle invalid")
    if not isinstance(state.get("transitions"), list) or not state.get("transitions"):
        errors.append("orchestration state transitions missing")
    if any(isinstance(item, dict) and item.get("status") != "resolved-and-reverified" for item in state.get("findings") or []):
        errors.append("orchestration state contains unresolved findings")
    artifacts = state.get("current_artifacts") or {}
    if not isinstance(artifacts, dict):
        errors.append("orchestration state current_artifacts must be object")
        artifacts = {}
    required_artifacts = {"packet-manifest", "pass-b-plan", "remote-gate"}
    missing = sorted(required_artifacts - set(artifacts))
    if missing:
        errors.append(f"orchestration state is missing current artifacts: {missing}")
    for name, item in artifacts.items():
        if not isinstance(item, dict):
            errors.append(f"orchestration artifact {name} invalid")
            continue
        artifact_path = resolve(path.parent, str(item.get("path", "")))
        if not is_nonempty(artifact_path):
            errors.append(f"orchestration artifact {name} missing or empty")
        elif item.get("sha256") != sha256_file(artifact_path):
            errors.append(f"orchestration artifact {name} hash mismatch")
        if item.get("head_sha") != data.get("head_sha"):
            errors.append(f"orchestration artifact {name} belongs to a different head SHA")
        if item.get("base_sha") != metadata.get("base_sha"):
            errors.append(f"orchestration artifact {name} belongs to a different base SHA")
        if item.get("merge_preview_sha") != state.get("merge_preview_sha"):
            errors.append(f"orchestration artifact {name} belongs to a different merge preview")
        if item.get("cycle") != state.get("cycle"):
            errors.append(f"orchestration artifact {name} belongs to a different cycle")
    return state
