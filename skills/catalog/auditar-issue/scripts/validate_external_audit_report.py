#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import jsonschema

from audit_signature import report_semantic_errors, verify_report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument("--trusted-auditors", required=True)
    args = parser.parse_args()
    report_path = Path(args.report).resolve()
    registry_path = Path(args.trusted_auditors).resolve()
    schema_dir = Path(__file__).resolve().parents[1] / "schemas"
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        report_schema = json.loads((schema_dir / "external-audit.schema.json").read_text(encoding="utf-8"))
        registry_schema = json.loads((schema_dir / "trusted-auditors.schema.json").read_text(encoding="utf-8"))
        jsonschema.Draft202012Validator(report_schema).validate(report)
        jsonschema.Draft202012Validator(registry_schema).validate(registry)
        datetime.fromisoformat(str(report["issued_at"]).replace("Z", "+00:00"))
        datetime.fromisoformat(str(report["signature"]["signed_at"]).replace("Z", "+00:00"))
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    errors = report_semantic_errors(report, require_signature=True)
    errors.extend(verify_report(report, registry))
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("PASS: signed external audit report accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
