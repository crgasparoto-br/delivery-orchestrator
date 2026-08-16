#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import jsonschema

from audit_signature import report_semantic_errors, sign_report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument("--private-key", required=True)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--password-env")
    args = parser.parse_args()
    report_path = Path(args.report).resolve()
    private_key_path = Path(args.private_key).resolve()
    if not report_path.is_file() or not private_key_path.is_file():
        print("error: report or private key is missing", file=sys.stderr)
        return 2
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"error: invalid report JSON: {exc}", file=sys.stderr)
        return 2
    password_value = os.environ.get(args.password_env) if args.password_env else None
    if args.password_env and not password_value:
        print(f"error: environment variable is missing: {args.password_env}", file=sys.stderr)
        return 2
    report.pop("signature", None)
    semantic_errors = report_semantic_errors(report, require_signature=False)
    if semantic_errors:
        for error in semantic_errors:
            print(f"error: {error}", file=sys.stderr)
        return 2
    try:
        sign_report(
            report,
            private_key_path.read_bytes(),
            password_value.encode("utf-8") if password_value else None,
            args.key_id,
            datetime.now(timezone.utc).isoformat(),
        )
        schema_path = Path(__file__).resolve().parents[1] / "schemas" / "external-audit.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        jsonschema.Draft202012Validator(schema).validate(report)
    except Exception as exc:
        print(f"error: report is incomplete or cannot be signed: {exc}", file=sys.stderr)
        return 2
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(report_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
