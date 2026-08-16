#!/usr/bin/env python3
"""Compute a deterministic fingerprint for an orchestration stage."""

import argparse
import hashlib
import json
from pathlib import Path


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_value(raw: str) -> tuple[str, str]:
    if "=" not in raw:
        raise argparse.ArgumentTypeError("--value must use key=value")
    key, value = raw.split("=", 1)
    if not key:
        raise argparse.ArgumentTypeError("--value key cannot be empty")
    return key, value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--input-file", action="append", default=[])
    parser.add_argument("--value", action="append", default=[], type=parse_value)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    inputs: list[dict] = []
    for raw_path in sorted(set(args.input_file)):
        path = Path(raw_path).resolve()
        if not path.is_file():
            parser.error(f"input file not found: {path}")
        data = path.read_bytes()
        inputs.append({
            "kind": "file",
            "name": str(path),
            "sha256": sha256_bytes(data),
            "size": len(data),
        })

    for key, value in sorted(args.value):
        encoded = value.encode("utf-8")
        inputs.append({
            "kind": "value",
            "name": key,
            "sha256": sha256_bytes(encoded),
            "size": len(encoded),
        })

    canonical = json.dumps(
        {"stage": args.stage, "inputs": inputs},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    payload = {
        "schema_version": 1,
        "stage": args.stage,
        "fingerprint": sha256_bytes(canonical),
        "inputs": inputs,
    }

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
