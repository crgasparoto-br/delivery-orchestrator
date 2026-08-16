#!/usr/bin/env python3
"""Fail closed when the requirement closure does not represent the full canonical specification."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from orchestrator_gate.specification import extract_candidates, sha256_file


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected object: {path}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--specification-snapshot", required=True)
    parser.add_argument("--requirement-closure", required=True)
    args = parser.parse_args()

    snapshot_path = Path(args.specification_snapshot).resolve()
    closure_path = Path(args.requirement_closure).resolve()
    errors: list[str] = []
    try:
        closure = load(closure_path)
        _, _, candidates = extract_candidates(snapshot_path, errors)
    except Exception as exc:
        print(f"BLOCK: invalid specification coverage inputs: {exc}")
        return 2

    snapshot_ref = closure.get("specification_snapshot") or {}
    if snapshot_ref.get("sha256") != sha256_file(snapshot_path):
        errors.append("requirement closure references a different specification snapshot")

    candidate_keys = {str(item.get("candidate_key")) for item in candidates}
    obligations = [item for item in closure.get("obligations") or [] if isinstance(item, dict)]
    obligation_keys = {str(item.get("candidate_key")) for item in obligations}
    missing = sorted(candidate_keys - obligation_keys)
    extra = sorted(obligation_keys - candidate_keys)
    if missing:
        errors.append(f"canonical specification candidates missing from closure: {missing}")
    if extra:
        errors.append(f"closure contains candidates not present in canonical specification: {extra}")

    by_source: dict[str, int] = {}
    for item in candidates:
        sid = str(item.get("source_id"))
        by_source[sid] = by_source.get(sid, 0) + 1
    coverage = {str(item.get("source_id")): item for item in closure.get("source_coverage") or [] if isinstance(item, dict)}
    for sid, count in by_source.items():
        item = coverage.get(sid)
        if not item:
            errors.append(f"source coverage missing source {sid}")
            continue
        if item.get("candidate_count") != count:
            errors.append(f"source {sid} candidate_count differs from canonical extraction")
        if item.get("unmapped_candidate_keys"):
            errors.append(f"source {sid} has unmapped candidate keys")

    covered_ids: set[str] = set()
    for item in obligations:
        oid = str(item.get("id") or "?")
        disposition = item.get("disposition")
        if disposition == "pending":
            errors.append(f"obligation {oid} is still pending")
        if disposition == "covered":
            covered_ids.add(oid)
            if not item.get("requirement_ids"):
                errors.append(f"covered obligation {oid} lacks requirement_ids")
        if disposition in {"deferred", "not-applicable"} and not str(item.get("rationale") or "").strip():
            errors.append(f"obligation {oid} disposition {disposition} lacks rationale")

    pass_c = closure.get("pass_c") or {}
    if pass_c.get("status") != "passed":
        errors.append("pass_c is not passed")
    if pass_c.get("reviewed_all_specification_sources") is not True:
        errors.append("pass_c did not review all specification sources")
    pass_c_ids = {str(value) for value in pass_c.get("obligation_ids") or []}
    missing_pass_c = sorted(covered_ids - pass_c_ids)
    if missing_pass_c:
        errors.append(f"covered obligations missing from pass_c: {missing_pass_c}")

    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2
    print("READY: canonical specification coverage is complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
