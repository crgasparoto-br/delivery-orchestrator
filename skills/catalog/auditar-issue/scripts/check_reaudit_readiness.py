#!/usr/bin/env python3
"""Validate a remediation packet before spending a full independent re-audit."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected object: {path}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--closure", required=True)
    parser.add_argument("--inherited-controls")
    parser.add_argument("--head-sha")
    args = parser.parse_args()
    path = Path(args.closure)
    if not path.is_file():
        print("BLOCK: audit-escape-closure.json is missing")
        return 2
    try:
        data = load(path)
    except Exception as exc:
        print(f"BLOCK: invalid audit escape closure: {exc}")
        return 2
    entries = data.get("escapes") if isinstance(data.get("escapes"), list) else [data]
    errors: list[str] = []
    for index, item in enumerate(entries):
        if not isinstance(item, dict):
            errors.append(f"entry {index} is invalid")
            continue
        eid = item.get("escape_id") or index
        if item.get("status") != "passed":
            errors.append(f"escape {eid} is not passed")
        if not str(item.get("escape_class") or "").strip():
            errors.append(f"escape {eid} lacks escape_class")
        if len(str(item.get("plausible_wrong_implementation") or "").strip()) < 20:
            errors.append(f"escape {eid} lacks plausible wrong implementation")
        siblings = item.get("sibling_cases") or []
        if len(siblings) < 2 or any(not isinstance(case, dict) or case.get("status") != "passed" for case in siblings):
            errors.append(f"escape {eid} sibling cases are incomplete")
        for key in ("prevention_change", "detection_change"):
            if not isinstance(item.get(key), dict) or not item[key].get("evidence"):
                errors.append(f"escape {eid} lacks {key} evidence")

    if args.inherited_controls:
        try:
            inherited = load(Path(args.inherited_controls))
        except Exception as exc:
            errors.append(f"invalid inherited controls: {exc}")
        else:
            if args.head_sha and inherited.get("head_sha") != args.head_sha:
                errors.append("inherited controls head_sha differs from candidate")
            controls = inherited.get("controls") or []
            if not controls:
                errors.append("re-audit requires cumulative inherited controls")
            for idx, item in enumerate(controls):
                cid = item.get("id") if isinstance(item, dict) else idx
                if not isinstance(item, dict) or item.get("status") != "passed":
                    errors.append(f"inherited control {cid} is not passed")
                    continue
                if args.head_sha and item.get("head_sha") != args.head_sha:
                    errors.append(f"inherited control {cid} was not executed on candidate head")
                if not str(item.get("evidence") or "").strip():
                    errors.append(f"inherited control {cid} lacks evidence")
            if inherited.get("unresolved_controls"):
                errors.append("inherited controls has unresolved_controls")
    else:
        errors.append("re-audit requires inherited-controls.json")

    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2
    print("READY: remediation class and cumulative inherited controls are complete for independent re-audit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
