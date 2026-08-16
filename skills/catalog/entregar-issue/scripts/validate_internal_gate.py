#!/usr/bin/env python3
"""Fail-closed entrypoint for the Orquestrador internal gate.

A successful real gate always performs a fresh GitHub recheck after local
validation. Offline validation is available only in explicit test mode.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from orchestrator_gate.remote_recheck import live_recheck
from orchestrator_gate.validator import validate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence")
    parser.add_argument("--report")
    parser.add_argument("--skip-remote-recheck", action="store_true")
    args = parser.parse_args()
    evidence_path = Path(args.evidence).resolve()
    if not evidence_path.is_file():
        print(f"FAIL: evidence file not found: {evidence_path}")
        return 2
    try:
        data = json.loads(evidence_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"FAIL: invalid evidence JSON: {exc}")
        return 2
    if not isinstance(data, dict):
        print("FAIL: evidence must be a JSON object")
        return 2
    report = validate(data, evidence_path)
    report["remote_recheck"] = None
    if not report["errors"]:
        if args.skip_remote_recheck:
            if os.environ.get("ORCHESTRATOR_TEST_MODE") != "1":
                report["errors"].append("--skip-remote-recheck is permitted only with ORCHESTRATOR_TEST_MODE=1")
            else:
                report["remote_recheck"] = {"skipped_for_test": True}
        else:
            snapshot_path = Path(str((data.get("remote_gate") or {}).get("snapshot_path", ""))).resolve()
            try:
                snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
                recheck_errors, recheck = live_recheck(data, snapshot)
                report["remote_recheck"] = {
                    "observed_at": datetime.now(timezone.utc).isoformat(),
                    **recheck,
                }
                report["errors"].extend(recheck_errors)
            except Exception as exc:
                report["errors"].append(f"live remote recheck failed: {exc}")
    report["result"] = "passed" if not report["errors"] else "failed"
    report_text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        target = Path(args.report).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(report_text, encoding="utf-8")
    if report["errors"]:
        print("FAIL: internal verification gate rejected")
        for error in report["errors"]:
            print(f"- {error}")
        return 1
    print("PASS: internal verification gate accepted")
    print(json.dumps(report["counts"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
