#!/usr/bin/env python3
"""Fail closed before handing a delivery to another independent audit."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"invalid JSON {path}: {exc}")
    if not isinstance(value, dict):
        raise SystemExit(f"expected JSON object: {path}")
    return value


def run_validator(args: list[str], errors: list[str]) -> None:
    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if proc.returncode == 0:
        return
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    errors.extend(lines or [f"validator failed: {' '.join(args)}"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--requirement-closure", required=True)
    parser.add_argument("--attack-matrix")
    parser.add_argument("--risk-saturation")
    parser.add_argument("--inherited-controls")
    parser.add_argument("--audit-escape-closure")
    parser.add_argument("--previous-independent-rejection", action="store_true")
    args = parser.parse_args()

    errors: list[str] = []
    closure_path = Path(args.requirement_closure)
    closure = load(closure_path)
    structural = closure.get("structural_invariant_closures") or {}
    structural_flags = {
        "structural", "forbidden-implementation", "canonical-path",
        "dependency-independence", "precedence",
    }
    structural_obligations = [
        item for item in closure.get("obligations") or []
        if isinstance(item, dict) and structural_flags.intersection(item.get("flags") or [])
        and item.get("disposition") == "covered"
    ]
    if structural_obligations and structural.get("status") != "passed":
        errors.append("structural invariant gate is not passed")
    if structural_obligations:
        required_ids = {str(item.get("id")) for item in structural_obligations}
        linked_ids = set()
        for entry in structural.get("entries") or []:
            if isinstance(entry, dict):
                linked_ids.update(str(value) for value in entry.get("obligation_ids") or [])
                if not entry.get("negative_control_evidence"):
                    errors.append(f"structural invariant {entry.get('id') or '?'} lacks negative control evidence")
                if len(str(entry.get("plausible_wrong_implementation") or "").strip()) < 20:
                    errors.append(f"structural invariant {entry.get('id') or '?'} lacks plausible wrong implementation")
        missing = required_ids - linked_ids
        if missing:
            errors.append(f"structural invariant gate does not cover obligations: {sorted(missing)}")
    if structural.get("unresolved_invariants"):
        errors.append("structural invariant gate has unresolved invariants")

    attack_path = Path(args.attack_matrix) if args.attack_matrix else closure_path.parent / "requirement-attack-matrix.json"
    risk_path = Path(args.risk_saturation) if args.risk_saturation else closure_path.parent / "risk-saturation.json"
    inherited_path = Path(args.inherited_controls) if args.inherited_controls else closure_path.parent / "inherited-controls.json"

    if not attack_path.is_file():
        errors.append("requirement-attack-matrix.json is missing")
        head_sha = ""
    else:
        matrix = load(attack_path)
        head_sha = str(matrix.get("head_sha") or "")
        run_validator([
            sys.executable, str(ROOT / "scripts" / "validate_requirement_attack_matrix.py"),
            "--requirement-closure", str(closure_path),
            "--attack-matrix", str(attack_path),
        ], errors)

    if not risk_path.is_file():
        errors.append("risk-saturation.json is missing")
    elif attack_path.is_file():
        run_validator([
            sys.executable, str(ROOT / "scripts" / "validate_risk_saturation.py"),
            "--attack-matrix", str(attack_path),
            "--risk-saturation", str(risk_path),
        ], errors)

    if not inherited_path.is_file():
        errors.append("inherited-controls.json is missing")
    elif head_sha:
        inherited_args = [
            sys.executable, str(ROOT / "scripts" / "validate_inherited_controls.py"),
            "--inherited-controls", str(inherited_path),
            "--head-sha", head_sha,
        ]
        if args.previous_independent_rejection:
            inherited_args.append("--previous-independent-rejection")
        run_validator(inherited_args, errors)

    escape_path = Path(args.audit_escape_closure) if args.audit_escape_closure else None
    if args.previous_independent_rejection and not escape_path:
        default_escape = closure_path.parent / "audit-escape-closure.json"
        escape_path = default_escape if default_escape.is_file() else None
    if args.previous_independent_rejection and not escape_path:
        errors.append("previous independent rejection requires audit-escape-closure.json")
    if escape_path:
        if not escape_path.is_file():
            errors.append("audit escape closure file is missing")
        else:
            escape = load(escape_path)
            entries = escape.get("escapes") if isinstance(escape.get("escapes"), list) else [escape]
            if not entries:
                errors.append("audit escape closure has no entries")
            for index, item in enumerate(entries):
                if not isinstance(item, dict):
                    errors.append(f"audit escape entry {index} is invalid")
                    continue
                if item.get("status") != "passed":
                    errors.append(f"audit escape {item.get('escape_id') or index} is not passed")
                siblings = item.get("sibling_cases") or []
                if len(siblings) < 2:
                    errors.append(f"audit escape {item.get('escape_id') or index} has fewer than two sibling cases")
                if any(not isinstance(case, dict) or case.get("status") != "passed" for case in siblings):
                    errors.append(f"audit escape {item.get('escape_id') or index} has sibling cases not passed")
                for key in ("prevention_change", "detection_change"):
                    if not isinstance(item.get(key), dict) or not item[key].get("evidence"):
                        errors.append(f"audit escape {item.get('escape_id') or index} lacks {key} evidence")

    if errors:
        for error in errors:
            if error.startswith("BLOCK:"):
                print(error)
            else:
                print(f"BLOCK: {error}")
        return 2
    print("READY: requirement attacks, risk saturation, inherited controls, structural invariants and audit escapes are closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
