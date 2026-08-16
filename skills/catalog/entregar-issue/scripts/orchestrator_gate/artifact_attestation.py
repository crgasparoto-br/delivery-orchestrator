from __future__ import annotations

import hashlib
import json
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

ALLOWED_ARTIFACT_KINDS = {
    "visual",
    "persistence-runtime",
    "migration-validation",
    "documentation-check",
    "audit-manifest",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and ".." not in path.parts


def verify_artifact_archive(
    archive: Path,
    *,
    artifact_id: int | None,
    run_id: int,
    head_sha: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "verified": False,
        "kind": "other",
        "manifest_path": "",
        "manifest_sha256": "",
        "checks": [],
        "results": [],
        "error": "embedded orquestrador-artifact.json not found",
    }
    errors: list[str] = []
    try:
        with zipfile.ZipFile(archive) as bundle:
            members = [name for name in bundle.namelist() if not name.endswith("/")]
            if any(not _safe_member(name) for name in members):
                errors.append("artifact archive contains an unsafe member path")
            manifests = [name for name in members if PurePosixPath(name).name == "orquestrador-artifact.json"]
            if len(manifests) != 1:
                errors.append(f"expected exactly one embedded attestation, found {len(manifests)}")
                result["error"] = "; ".join(errors)
                return result
            manifest_path = manifests[0]
            raw = bundle.read(manifest_path)
            manifest = json.loads(raw.decode("utf-8"))
            if not isinstance(manifest, dict):
                raise ValueError("artifact attestation must be a JSON object")

            if manifest.get("schema_version") != 2:
                errors.append("schema_version must be 2")
            kind = manifest.get("kind")
            if kind not in ALLOWED_ARTIFACT_KINDS:
                errors.append("kind is missing or unsupported")
            if manifest.get("head_sha") != head_sha:
                errors.append("head_sha differs from final SHA")
            if manifest.get("run_id") != run_id:
                errors.append("run_id differs from producing workflow run")
            if artifact_id is not None and manifest.get("artifact_id") != artifact_id:
                errors.append("artifact_id differs from GitHub artifact")
            generator = manifest.get("generator")
            if not isinstance(generator, str) or len(generator.strip()) < 3:
                errors.append("generator is required")
            generated_at = manifest.get("generated_at")
            if not isinstance(generated_at, str) or len(generated_at) < 10:
                errors.append("generated_at is required")
            else:
                try:
                    datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
                except ValueError:
                    errors.append("generated_at must be ISO-8601")

            checks = manifest.get("checks")
            results = manifest.get("results")
            if not isinstance(checks, list) or not checks:
                errors.append("checks must be a non-empty list")
                checks = []
            if not isinstance(results, list) or not results:
                errors.append("results must be a non-empty list")
                results = []

            check_by_id: dict[str, dict[str, Any]] = {}
            for index, check in enumerate(checks):
                if not isinstance(check, dict):
                    errors.append(f"check[{index}] must be an object")
                    continue
                check_id = check.get("id")
                claim = check.get("claim")
                result_paths = check.get("result_paths")
                if not isinstance(check_id, str) or not check_id.strip():
                    errors.append(f"check[{index}].id is required")
                    continue
                if check_id in check_by_id:
                    errors.append(f"duplicate check id: {check_id}")
                    continue
                if not isinstance(claim, str) or len(claim.strip()) < 12:
                    errors.append(f"check {check_id}: claim is insufficient")
                if not isinstance(result_paths, list) or not result_paths or any(
                    not isinstance(item, str) or not _safe_member(item) for item in result_paths
                ):
                    errors.append(f"check {check_id}: result_paths must contain safe archive members")
                    result_paths = []
                check_by_id[check_id] = {"id": check_id, "claim": claim, "result_paths": result_paths}

            result_by_path: dict[str, dict[str, Any]] = {}
            verified_results: list[dict[str, Any]] = []
            for index, item in enumerate(results):
                if not isinstance(item, dict):
                    errors.append(f"result[{index}] must be an object")
                    continue
                path = item.get("path")
                if not isinstance(path, str) or not _safe_member(path) or path == manifest_path:
                    errors.append(f"result[{index}].path is invalid")
                    continue
                if path in result_by_path:
                    errors.append(f"duplicate result path: {path}")
                    continue
                if path not in members:
                    errors.append(f"result file is missing from artifact: {path}")
                    continue
                payload = bundle.read(path)
                if not payload:
                    errors.append(f"result file is empty: {path}")
                expected_hash = item.get("sha256")
                if expected_hash != _sha256(payload):
                    errors.append(f"result hash mismatch: {path}")
                if item.get("size") != len(payload):
                    errors.append(f"result size mismatch: {path}")
                command = item.get("command")
                if not isinstance(command, str) or len(command.strip()) < 4:
                    errors.append(f"result command is required: {path}")
                exit_code = item.get("exit_code")
                expected_exit = item.get("expected_exit")
                if not isinstance(exit_code, int) or not isinstance(expected_exit, int):
                    errors.append(f"result exit codes must be integers: {path}")
                elif exit_code != expected_exit:
                    errors.append(f"result command did not meet expected exit code: {path}")
                check_ids = item.get("check_ids")
                if not isinstance(check_ids, list) or not check_ids or any(
                    not isinstance(check_id, str) or check_id not in check_by_id for check_id in check_ids
                ):
                    errors.append(f"result check_ids are invalid: {path}")
                    check_ids = []
                media_type = item.get("media_type")
                if not isinstance(media_type, str) or "/" not in media_type:
                    errors.append(f"result media_type is required: {path}")
                normalized = {
                    "path": path,
                    "sha256": expected_hash,
                    "size": item.get("size"),
                    "command": command,
                    "exit_code": exit_code,
                    "expected_exit": expected_exit,
                    "check_ids": check_ids,
                    "media_type": media_type,
                }
                result_by_path[path] = normalized
                verified_results.append(normalized)

            for check_id, check in check_by_id.items():
                for path in check["result_paths"]:
                    item = result_by_path.get(path)
                    if item is None:
                        errors.append(f"check {check_id} references a missing result: {path}")
                    elif check_id not in item.get("check_ids", []):
                        errors.append(f"check/result link is not bidirectional: {check_id}/{path}")
            for path, item in result_by_path.items():
                for check_id in item.get("check_ids", []):
                    if path not in check_by_id.get(check_id, {}).get("result_paths", []):
                        errors.append(f"result/check link is not bidirectional: {path}/{check_id}")

            result.update({
                "verified": not errors,
                "kind": kind if not errors else "other",
                "manifest_path": manifest_path,
                "manifest_sha256": _sha256(raw),
                "checks": list(check_by_id.values()),
                "results": verified_results,
                "error": "; ".join(errors),
            })
    except Exception as exc:
        result["error"] = f"invalid artifact archive or attestation: {exc}"
    return result
