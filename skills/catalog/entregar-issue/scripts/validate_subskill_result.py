#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path

from planning_contract_runtime import validate_subskill_result


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Validate a structured subskill result")
    parser.add_argument("result")
    args = parser.parse_args()

    result_path = Path(args.result).resolve()
    payload = json.loads(result_path.read_text(encoding="utf-8"))
    schema_errors: list[str] = []
    try:
        validate_subskill_result(payload)
    except ValueError as exc:
        schema_errors.append(str(exc))
    semantic_errors: list[str] = []

    if payload.get("reused") is True:
        source = payload.get("reuse_source", {})
        if source.get("input_fingerprint") != payload.get("input_fingerprint"):
            semantic_errors.append("reuse_source.input_fingerprint must equal input_fingerprint")
        raw_source_path = source.get("result_path")
        if isinstance(raw_source_path, str) and raw_source_path:
            source_path = Path(raw_source_path)
            if not source_path.is_absolute():
                source_path = result_path.parent / source_path
            source_path = source_path.resolve()
            if source_path == result_path:
                semantic_errors.append("reuse_source.result_path must reference a prior result, not itself")
            elif not source_path.is_file():
                semantic_errors.append(f"reuse_source.result_path does not exist: {source_path}")
            elif file_sha256(source_path) != source.get("sha256"):
                semantic_errors.append("reuse_source.sha256 does not match the referenced result")

    if schema_errors or semantic_errors:
        for error in schema_errors:
            print(f"$: {error}")
        for error in semantic_errors:
            print(f"$: {error}")
        raise SystemExit(1)
    print("valid")


if __name__ == "__main__":
    main()
