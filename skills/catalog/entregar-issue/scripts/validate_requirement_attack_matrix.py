#!/usr/bin/env python3
"""Compatibility wrapper that adds a fail-closed semantic echo guard."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

CORE = Path(__file__).with_name("validate_requirement_attack_matrix_core.py")
WORD_RE = re.compile(r"[a-z0-9]+", re.I)
NOISE = {
    "a", "an", "and", "are", "as", "at", "be", "behavior", "boundary", "boundaries",
    "candidate", "case", "cases", "check", "control", "correct", "detail", "details",
    "dimension", "every", "expected", "generic", "implementation", "invalid", "is", "it",
    "make", "mechanism", "negative", "observed", "pass", "passed", "passes", "placeholder",
    "positive", "reject", "rejected", "rejects", "result", "results", "run", "scenario",
    "should", "still", "surface", "target", "targets", "test", "tests", "the", "thing",
    "things", "this", "unsafe", "validation", "value", "values", "wrong", "with", "without",
    "from", "into", "for", "that", "only", "while", "before", "after", "during", "when",
    "then", "than", "through", "accept", "accepted", "accepts",
}


def terms(value: object) -> set[str]:
    return {
        word.lower()
        for word in WORD_RE.findall(str(value or ""))
        if len(word) >= 3 and word.lower() not in NOISE
    }


def novel(value: object, anchors: set[str], label: str, errors: list[str]) -> set[str]:
    detail = terms(value) - anchors
    if len(detail) < 2:
        errors.append(f"{label} only echoes declared surface/dimension without concrete operational detail")
    return detail


def coupled(detail: set[str], previous: set[str], label: str, errors: list[str]) -> None:
    if previous and not detail.intersection(previous):
        errors.append(f"{label} concrete operational detail is not coupled to the exercised mechanism")


def guard_control(control: dict, label: str, errors: list[str]) -> None:
    anchors = terms(control.get("surface")) | terms(control.get("dimension"))
    semantic = control.get("semantic_evidence") if isinstance(control.get("semantic_evidence"), dict) else {}
    mechanism = semantic.get("mechanism") if isinstance(semantic.get("mechanism"), dict) else {}
    procedure = semantic.get("procedure") if isinstance(semantic.get("procedure"), dict) else {}
    outcome = semantic.get("outcome") if isinstance(semantic.get("outcome"), dict) else {}

    target = novel(mechanism.get("target"), anchors, f"{label} semantic mechanism target", errors)
    stimulus = novel(procedure.get("stimulus"), anchors, f"{label} semantic procedure stimulus", errors)
    coupled(stimulus, target, f"{label} semantic procedure stimulus", errors)
    observable = novel(procedure.get("observable"), anchors, f"{label} semantic procedure observable", errors)
    coupled(observable, target | stimulus, f"{label} semantic procedure observable", errors)
    expected_signal = novel(outcome.get("expected_signal"), anchors, f"{label} semantic expected signal", errors)
    coupled(expected_signal, target | observable, f"{label} semantic expected signal", errors)
    observed_signal = novel(outcome.get("observed_signal"), anchors, f"{label} semantic observed signal", errors)
    coupled(observed_signal, observable | expected_signal, f"{label} semantic observed signal", errors)

    for key in ("failure_mode", "plausible_wrong_implementation", "procedure", "expected", "observed"):
        detail = novel(control.get(key), anchors, f"{label} {key}", errors)
        if key == "procedure":
            coupled(detail, stimulus | observable, f"{label} procedure", errors)
        elif key == "expected":
            coupled(detail, expected_signal, f"{label} expected", errors)
        elif key == "observed":
            coupled(detail, observed_signal, f"{label} observed", errors)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--requirement-closure", required=True)
    parser.add_argument("--attack-matrix", required=True)
    args = parser.parse_args()

    proc = subprocess.run(
        [sys.executable, str(CORE), "--requirement-closure", args.requirement_closure, "--attack-matrix", args.attack_matrix],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if proc.stdout:
        print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
    if proc.returncode != 0:
        return proc.returncode

    matrix = json.loads(Path(args.attack_matrix).read_text(encoding="utf-8"))
    errors: list[str] = []
    for item in matrix.get("requirements") or []:
        if not isinstance(item, dict):
            continue
        rid = str(item.get("requirement_id") or "?")
        surface_anchors: set[str] = set()
        for entry in item.get("risk_surfaces") or []:
            if isinstance(entry, dict):
                surface_anchors |= terms(entry.get("surface"))
            elif isinstance(entry, str):
                surface_anchors |= terms(entry)
        novel(item.get("plausible_wrong_implementation"), surface_anchors, f"requirement {rid} plausible wrong implementation", errors)
        for index, control in enumerate(item.get("negative_controls") or []):
            if isinstance(control, dict):
                guard_control(control, f"requirement {rid} negative control {index}", errors)

    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2
    print("READY: semantic echo guard requires concrete operational detail beyond surface/dimension labels")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
