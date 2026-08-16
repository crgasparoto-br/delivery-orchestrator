#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from orchestrator_gate.specification import TEXTUAL_KINDS, sha256_file

ID_RE = re.compile(r"^SRC-[A-Z0-9][A-Z0-9-]*$")


def parse_source(value: str, binary: bool) -> tuple[str, str, Path, str | None]:
    parts = value.split(":", 3 if binary else 2)
    expected = 4 if binary else 3
    if len(parts) != expected:
        kind = "binary-source" if binary else "source"
        raise ValueError(f"{kind} must use KIND:SRC-ID:PATH" + (":EXTRACT-SRC-ID" if binary else ""))
    source_kind, source_id, path_text = parts[:3]
    extract_id = parts[3] if binary else None
    if not ID_RE.fullmatch(source_id):
        raise ValueError(f"invalid source id: {source_id}")
    path = Path(path_text).resolve()
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"source file missing or empty: {path}")
    if not binary and source_kind not in TEXTUAL_KINDS:
        raise ValueError(f"unsupported textual source kind: {source_kind}")
    return source_kind, source_id, path, extract_id


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--issue", required=True, type=int)
    parser.add_argument("--primary-source-id", required=True)
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--binary-source", action="append", default=[])
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    out = Path(args.out).resolve()
    source_dir = out.parent / "specification-sources"
    if source_dir.exists():
        shutil.rmtree(source_dir)
    source_dir.mkdir(parents=True)
    sources: list[dict[str, object]] = []
    ids: set[str] = set()

    try:
        parsed = [parse_source(value, False) for value in args.source]
        parsed += [parse_source(value, True) for value in args.binary_source]
    except ValueError as exc:
        raise SystemExit(str(exc))
    if not parsed:
        raise SystemExit("at least one specification source is required")

    for kind, source_id, source_path, extract_id in parsed:
        if source_id in ids:
            raise SystemExit(f"duplicate source id: {source_id}")
        ids.add(source_id)
        textual = extract_id is None
        suffix = ".txt" if textual else (source_path.suffix or ".bin")
        target = source_dir / f"{source_id}{suffix}"
        if textual:
            try:
                text = source_path.read_text(encoding="utf-8")
            except Exception as exc:
                raise SystemExit(f"textual source must be UTF-8: {source_path}: {exc}")
            target.write_text(text, encoding="utf-8")
            line_count = len(text.splitlines())
        else:
            shutil.copyfile(source_path, target)
            line_count = 0
        sources.append({
            "id": source_id,
            "kind": kind,
            "path": target.relative_to(out.parent).as_posix(),
            "locator": str(source_path),
            "sha256": sha256_file(target),
            "textual": textual,
            "extract_source_id": extract_id,
            "required": True,
            "line_count": line_count,
        })

    if args.primary_source_id not in ids:
        raise SystemExit("primary source id is not present")
    primary = next(item for item in sources if item["id"] == args.primary_source_id)
    if primary["kind"] != "issue-body" or primary["textual"] is not True:
        raise SystemExit("primary source must be a textual issue-body source")
    for item in sources:
        extract_id = item.get("extract_source_id")
        if extract_id and extract_id not in ids:
            raise SystemExit(f"binary source {item['id']} references missing extraction source {extract_id}")

    payload = {
        "schema_version": 1,
        "repository": args.repository,
        "issue": args.issue,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "primary_source_id": args.primary_source_id,
        "sources": sources,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
