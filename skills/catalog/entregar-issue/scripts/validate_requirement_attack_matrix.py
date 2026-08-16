#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

HIGH_RISK = {
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-destination", "concurrency-atomicity", "idempotency", "rollback",
    "historical-immutability",
}
SHA_RE = re.compile(r"^[0-9a-f]{40,64}$", re.I)


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"invalid JSON {path}: {exc}")
    if not isinstance(value, dict):
        raise SystemExit(f"expected JSON object: {path}")
    return value


def passed_control(control: object, head_sha: str, label: str, errors: list[str], require_siblings: int = 0) -> None:
    if not isinstance(control, dict):
        errors.append(f"{label} is missing")
        return
    if control.get("status") != "passed":
        errors.append(f"{label} is not passed")
    if str(control.get("head_sha") or "") != head_sha:
        errors.append(f"{label} head_sha does not match attack matrix head")
    evidence = str(control.get("evidence") or control.get("evidence_path") or "").strip()
    if not evidence:
        errors.append(f"{label} lacks evidence")
    if require_siblings:
        siblings = control.get("sibling_cases") or []
        if len(siblings) < require_siblings:
            errors.append(f"{label} has fewer than {require_siblings} sibling cases")
        elif any(not isinstance(case, dict) or case.get("status") != "passed" for case in siblings):
            errors.append(f"{label} has sibling cases not passed")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--requirement-closure", required=True)
    parser.add_argument("--attack-matrix", required=True)
    args = parser.parse_args()

    closure = load(Path(args.requirement_closure))
    matrix = load(Path(args.attack_matrix))
    errors: list[str] = []
    head_sha = str(matrix.get("head_sha") or "")
    if matrix.get("schema_version") != 1:
        errors.append("attack matrix schema_version must be 1")
    if not SHA_RE.match(head_sha):
        errors.append("attack matrix head_sha is invalid")

    required: set[str] = set()
    for obligation in closure.get("obligations") or []:
        if not isinstance(obligation, dict) or obligation.get("disposition") != "covered":
            continue
        required.update(str(value) for value in obligation.get("requirement_ids") or [])

    entries = matrix.get("requirements") or []
    by_id = {str(item.get("requirement_id")): item for item in entries if isinstance(item, dict)}
    missing = sorted(required - set(by_id))
    if missing:
        errors.append(f"attack matrix does not cover requirements: {missing}")
    if matrix.get("uncovered_requirements"):
        errors.append("attack matrix has uncovered_requirements")

    for rid in sorted(required & set(by_id)):
        item = by_id[rid]
        wrong = str(item.get("plausible_wrong_implementation") or "").strip()
        if len(wrong) < 20:
            errors.append(f"requirement {rid} lacks plausible wrong implementation")
        families = {str(value) for value in item.get("risk_families") or []}
        if not families:
            errors.append(f"requirement {rid} has no risk families")
        passed_control(item.get("positive_control"), head_sha, f"requirement {rid} positive control", errors)
        negative = item.get("negative_controls") or []
        if not negative:
            errors.append(f"requirement {rid} has no negative controls")
        sibling_min = 2 if HIGH_RISK.intersection(families) else 1
        for index, control in enumerate(negative):
            passed_control(control, head_sha, f"requirement {rid} negative control {index}", errors, sibling_min)
        regression = item.get("regression_controls") or []
        if not regression:
            errors.append(f"requirement {rid} has no regression controls")
        for index, control in enumerate(regression):
            passed_control(control, head_sha, f"requirement {rid} regression control {index}", errors)

    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2
    print("READY: every covered requirement has positive, adversarial and regression evidence")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
