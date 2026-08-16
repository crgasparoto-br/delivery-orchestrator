from __future__ import annotations

from pathlib import Path
from typing import Any

from .utils import is_nonempty, load_json, sha256_file


def validate_packet(data: dict[str, Any], errors: list[str]) -> tuple[Path, dict, list[dict], dict]:
    packet = Path(str(data.get("packet_path", ""))).resolve()
    manifest_path = packet / "manifest.json"
    metadata_path = packet / "metadata.json"
    manifest = load_json(manifest_path, "packet manifest", errors)
    metadata = load_json(metadata_path, "packet metadata", errors)
    if manifest and manifest.get("schema_version") != 3:
        errors.append("packet manifest schema_version must be 3")
    if metadata and metadata.get("schema_version") != 3:
        errors.append("packet metadata schema_version must be 3")
    if is_nonempty(manifest_path) and data.get("packet_manifest_sha256") != sha256_file(manifest_path):
        errors.append("packet_manifest_sha256 does not match manifest")
    declared_paths = {entry.get("path") for entry in manifest.get("files", []) if isinstance(entry, dict) and isinstance(entry.get("path"), str)} if isinstance(manifest, dict) else set()
    actual_paths = {path.relative_to(packet).as_posix() for path in packet.rglob("*") if path.is_file() and path.name not in {"manifest.json", "manifest.sha256"}} if packet.is_dir() else set()
    if declared_paths != actual_paths:
        errors.append(f"packet manifest inventory mismatch; missing={sorted(actual_paths-declared_paths)}, extra={sorted(declared_paths-actual_paths)}")
    for entry in manifest.get("files", []) if isinstance(manifest, dict) else []:
        if not isinstance(entry, dict):
            errors.append("packet manifest entry must be object")
            continue
        rel = entry.get("path")
        if not isinstance(rel, str):
            errors.append("packet manifest entry path missing")
            continue
        target = packet / rel
        if not target.is_file():
            errors.append(f"packet file missing: {rel}")
        elif entry.get("sha256") != sha256_file(target):
            errors.append(f"packet file hash mismatch: {rel}")
    specification_snapshot = packet / "specification-snapshot.json"
    if not is_nonempty(specification_snapshot):
        errors.append("specification-snapshot.json missing from audit packet")
    elif metadata.get("specification_snapshot_sha256") != sha256_file(specification_snapshot):
        errors.append("packet specification snapshot hash mismatch")
    source_count = 0
    specification_sources = packet / "specification-sources"
    if specification_sources.is_dir():
        source_count = sum(1 for path in specification_sources.rglob("*") if path.is_file())
    if metadata.get("specification_source_count") != source_count:
        errors.append("packet specification source count mismatch")
    coverage = load_json(packet / "runtime_graph_coverage.json", "runtime graph coverage", errors)
    if coverage and coverage.get("schema_version") != 2:
        errors.append("runtime graph coverage schema_version must be 2")
    if coverage and coverage.get("complete") is not True:
        errors.append(f"runtime graph is incomplete: {coverage.get('limitations') or []}")
    context_raw = []
    context_path = packet / "production_context_files.json"
    if is_nonempty(context_path):
        try:
            import json
            loaded = json.loads(context_path.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                context_raw = [item for item in loaded if isinstance(item, dict)]
            else:
                errors.append("production_context_files.json must be list")
        except Exception as exc:
            errors.append(f"production_context_files.json invalid: {exc}")
    else:
        errors.append("production_context_files.json missing")
    for item in context_raw:
        rel = item.get("path")
        if not isinstance(rel, str):
            errors.append("runtime context path missing")
            continue
        target = packet / "production-context" / rel
        if not target.is_file():
            errors.append(f"runtime context snapshot missing: {rel}")
        elif item.get("sha256") != sha256_file(target):
            errors.append(f"runtime context snapshot hash mismatch: {rel}")
    if metadata:
        if metadata.get("head_sha") != data.get("head_sha"):
            errors.append("packet head_sha differs from evidence")
        if metadata.get("base_ref") != data.get("base_ref"):
            errors.append("packet base_ref differs from evidence")
        if metadata.get("runtime_graph_complete") is not True:
            errors.append("packet metadata reports incomplete runtime graph")
    return packet, metadata, context_raw, coverage
