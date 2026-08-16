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
CONTROL_TYPES = {"test", "gate", "scenario", "procedure"}
PROCEDURE_OPERATIONS = {
    "execute", "validate", "inspect", "probe", "compare", "inject", "configure",
    "dispatch", "observe", "create", "read", "write", "exercise", "scan", "rebuild",
    "evaluate", "materialize", "prepare", "classify", "run",
}
SHA_RE = re.compile(r"^[0-9a-f]{40,64}$", re.I)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$", re.I)
SURFACE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
WORD_RE = re.compile(r"[a-z0-9]+", re.I)
GENERIC_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "behavior", "candidate", "check",
    "control", "correct", "expected", "generic", "implementation", "invalid", "is", "it",
    "negative", "observed", "pass", "passed", "passes", "placeholder", "positive", "reject",
    "rejected", "remains", "run", "scenario", "should", "still", "test", "tests", "the",
    "this", "unsafe", "validation", "wrong", "with", "without", "from", "into", "for", "that",
    "only", "while", "before", "after", "during", "when", "then", "than", "through", "every",
}


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"invalid JSON {path}: {exc}")
    if not isinstance(value, dict):
        raise SystemExit(f"expected JSON object: {path}")
    return value


def compact_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(compact_text(v) for v in value.values())
    if isinstance(value, list):
        return " ".join(compact_text(v) for v in value)
    return str(value)


def words(value: object) -> list[str]:
    return [word.lower() for word in WORD_RE.findall(str(value or ""))]


def specific_terms(value: object) -> set[str]:
    return {word for word in words(value) if len(word) >= 3 and word not in GENERIC_WORDS}


def validate_specific_text(value: object, label: str, errors: list[str], *, minimum_chars: int, minimum_words: int) -> None:
    text = str(value or "").strip()
    if len(text) < minimum_chars:
        errors.append(f"{label} is too short")
        return
    tokens = words(text)
    if len(tokens) < minimum_words:
        errors.append(f"{label} is not specific enough")
        return
    if len(specific_terms(text)) < 2:
        errors.append(f"{label} is a generic placeholder")


def require_overlap(value: object, anchors: set[str], label: str, errors: list[str]) -> None:
    if anchors and not (specific_terms(value) & anchors):
        errors.append(f"{label} is not semantically bound to its declared mechanism")


def surface_context_terms(item: dict) -> set[str]:
    anchors: set[str] = set()
    for entry in item.get("risk_surfaces") or []:
        if isinstance(entry, dict):
            anchors.update(specific_terms(entry.get("surface")))
            anchors.update(specific_terms(entry.get("reason")))
        elif isinstance(entry, str):
            anchors.update(specific_terms(entry))
    return anchors


def validate_semantic_evidence(control: dict, label: str, errors: list[str]) -> set[str]:
    evidence = control.get("semantic_evidence")
    if not isinstance(evidence, dict):
        errors.append(f"{label} lacks semantic_evidence")
        return set()

    mechanism = evidence.get("mechanism")
    procedure = evidence.get("procedure")
    outcome = evidence.get("outcome")
    if not isinstance(mechanism, dict):
        errors.append(f"{label} semantic_evidence.mechanism is missing")
        mechanism = {}
    if not isinstance(procedure, dict):
        errors.append(f"{label} semantic_evidence.procedure is missing")
        procedure = {}
    if not isinstance(outcome, dict):
        errors.append(f"{label} semantic_evidence.outcome is missing")
        outcome = {}

    surface = str(control.get("surface") or "").strip()
    dimension = str(control.get("dimension") or "").strip()
    if mechanism.get("surface") != surface:
        errors.append(f"{label} semantic mechanism surface does not match control surface")
    if mechanism.get("dimension") != dimension:
        errors.append(f"{label} semantic mechanism dimension does not match control dimension")

    mechanism_anchors = specific_terms(surface) | specific_terms(dimension)
    target = mechanism.get("target")
    validate_specific_text(target, f"{label} semantic mechanism target", errors, minimum_chars=12, minimum_words=4)
    require_overlap(target, mechanism_anchors, f"{label} semantic mechanism target", errors)
    context = mechanism_anchors | specific_terms(target)

    operation = str(procedure.get("operation") or "").strip().lower()
    if operation not in PROCEDURE_OPERATIONS:
        errors.append(f"{label} semantic procedure operation is invalid")
    stimulus = procedure.get("stimulus")
    observable = procedure.get("observable")
    validate_specific_text(stimulus, f"{label} semantic procedure stimulus", errors, minimum_chars=12, minimum_words=4)
    validate_specific_text(observable, f"{label} semantic procedure observable", errors, minimum_chars=12, minimum_words=4)
    require_overlap(stimulus, context, f"{label} semantic procedure stimulus", errors)
    require_overlap(observable, context | specific_terms(stimulus), f"{label} semantic procedure observable", errors)

    expected_signal = outcome.get("expected_signal")
    observed_signal = outcome.get("observed_signal")
    validate_specific_text(expected_signal, f"{label} semantic outcome expected_signal", errors, minimum_chars=12, minimum_words=4)
    validate_specific_text(observed_signal, f"{label} semantic outcome observed_signal", errors, minimum_chars=12, minimum_words=4)
    signal_context = context | specific_terms(observable)
    require_overlap(expected_signal, signal_context, f"{label} semantic outcome expected_signal", errors)
    require_overlap(observed_signal, signal_context | specific_terms(expected_signal), f"{label} semantic outcome observed_signal", errors)
    if outcome.get("evidence_sha256") != control.get("evidence_sha256"):
        errors.append(f"{label} semantic outcome evidence_sha256 does not match control evidence_sha256")

    narrative_context = context | specific_terms(stimulus) | specific_terms(observable)
    require_overlap(control.get("failure_mode"), narrative_context, f"{label} failure_mode", errors)
    require_overlap(control.get("plausible_wrong_implementation"), narrative_context, f"{label} plausible_wrong_implementation", errors)
    free_procedure = str(control.get("procedure") or "")
    if operation and operation not in words(free_procedure):
        errors.append(f"{label} procedure does not name semantic operation {operation}")
    require_overlap(free_procedure, narrative_context, f"{label} procedure", errors)
    require_overlap(control.get("expected"), specific_terms(expected_signal), f"{label} expected", errors)
    require_overlap(control.get("observed"), specific_terms(observed_signal), f"{label} observed", errors)
    return context


# Deterministic safety net for authorization surfaces that are obvious from the attack description.
SURFACE_HINTS = {
    "environment": ("process.env", "extraenv", "environment variable", "environment variables", "env var", "env vars", "child environment"),
    "filesystem": ("filesystem", "file system", "private key", "signing key", "read file", "readable file", "path sibling", "sibling path"),
    "persistent-credential-store": ("codex_home", "codex home", "auth.json", "credential cache", "persistent home", "persistent credential", "refresh token"),
    "artifact-export": ("artifact upload", "upload artifact", "run artifact", "forensic state", "exported run"),
    "process-identity": ("same user", "same uid", "process isolation", "container", "virtual machine", "mount namespace", "runner user"),
}


def declared_surfaces(item: dict, families: set[str], errors: list[str], rid: str) -> set[tuple[str, str]]:
    raw = item.get("risk_surfaces") or []
    result: set[tuple[str, str]] = set()
    for index, entry in enumerate(raw):
        if isinstance(entry, str):
            if len(families) != 1:
                errors.append(f"requirement {rid} risk surface {index} must name risk_family when multiple families apply")
                continue
            family = next(iter(families)); surface = entry.strip()
        elif isinstance(entry, dict):
            family = str(entry.get("risk_family") or entry.get("family") or "").strip()
            surface = str(entry.get("surface") or "").strip()
            if len(str(entry.get("reason") or "").strip()) < 8:
                errors.append(f"requirement {rid} risk surface {index} lacks reason")
        else:
            errors.append(f"requirement {rid} risk surface {index} is invalid"); continue
        if family not in families:
            errors.append(f"requirement {rid} risk surface {index} references non-applicable family {family or '?'}")
        if not SURFACE_RE.match(surface):
            errors.append(f"requirement {rid} risk surface {index} has invalid surface {surface or '?'}")
        if family and surface:
            result.add((family, surface))
    return result


def inferred_surfaces(item: dict, families: set[str]) -> set[str]:
    if "authorization" not in families:
        return set()
    text = compact_text({
        "plausible_wrong_implementation": item.get("plausible_wrong_implementation"),
        "negative_controls": [{"failure_mode": c.get("failure_mode"), "plausible_wrong_implementation": c.get("plausible_wrong_implementation"), "procedure": c.get("procedure")} for c in item.get("negative_controls") or [] if isinstance(c, dict)],
    }).lower()
    return {surface for surface, hints in SURFACE_HINTS.items() if any(hint in text for hint in hints)}


def validate_basic_control(control: object, head_sha: str, label: str, errors: list[str]) -> bool:
    if not isinstance(control, dict):
        errors.append(f"{label} is missing"); return False
    if control.get("status") != "passed": errors.append(f"{label} is not passed")
    if str(control.get("head_sha") or "") != head_sha: errors.append(f"{label} head_sha does not match attack matrix head")
    if not str(control.get("evidence") or control.get("evidence_path") or "").strip(): errors.append(f"{label} lacks evidence")
    return True


def validate_negative_control(control: object, head_sha: str, label: str, families: set[str], surfaces: set[tuple[str, str]], errors: list[str], require_siblings: int) -> set[tuple[str, str, str]]:
    covered: set[tuple[str, str, str]] = set()
    if not validate_basic_control(control, head_sha, label, errors) or not isinstance(control, dict): return covered
    cid = str(control.get("id") or "").strip(); family = str(control.get("risk_family") or "").strip(); surface = str(control.get("surface") or "").strip(); dimension = str(control.get("dimension") or "").strip()
    if not cid: errors.append(f"{label} lacks id")
    if family not in families: errors.append(f"{label} risk_family is not declared by the requirement")
    if (family, surface) not in surfaces: errors.append(f"{label} surface {surface or '?'} is not declared in requirement risk_surfaces")
    if len(dimension) < 3: errors.append(f"{label} lacks discriminant dimension")
    for key, chars, count in (("failure_mode",12,6),("plausible_wrong_implementation",20,6),("procedure",12,6),("expected",8,5),("observed",8,5)):
        validate_specific_text(control.get(key), f"{label} {key}", errors, minimum_chars=chars, minimum_words=count)
    if str(control.get("control_type") or "") not in CONTROL_TYPES: errors.append(f"{label} has invalid control_type")
    if not SHA256_RE.match(str(control.get("evidence_sha256") or "").strip()): errors.append(f"{label} lacks valid evidence_sha256")
    validate_semantic_evidence(control, label, errors)
    if family and surface and dimension: covered.add((family, surface, dimension))
    siblings = control.get("sibling_cases") or []
    if len(siblings) < require_siblings: errors.append(f"{label} has fewer than {require_siblings} sibling cases")
    sibling_pairs: set[tuple[str, str]] = set()
    for index, case in enumerate(siblings):
        slabel=f"{label} sibling {index}"
        if not isinstance(case,dict): errors.append(f"{slabel} is invalid"); continue
        if case.get("status") != "passed": errors.append(f"{slabel} is not passed")
        sid=str(case.get("id") or "").strip(); ssurface=str(case.get("surface") or "").strip(); sdimension=str(case.get("dimension") or "").strip()
        if not sid: errors.append(f"{slabel} lacks id")
        if (family, ssurface) not in surfaces: errors.append(f"{slabel} surface {ssurface or '?'} is not declared in requirement risk_surfaces")
        if len(sdimension)<3: errors.append(f"{slabel} lacks dimension")
        if ssurface and sdimension: sibling_pairs.add((ssurface,sdimension)); covered.add((family,ssurface,sdimension))
    if require_siblings and len(sibling_pairs)<require_siblings: errors.append(f"{label} sibling cases do not vary {require_siblings} distinct surface/dimension pairs")
    return covered


def main() -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--requirement-closure",required=True); parser.add_argument("--attack-matrix",required=True); args=parser.parse_args()
    closure=load(Path(args.requirement_closure)); matrix=load(Path(args.attack_matrix)); errors: list[str]=[]; head_sha=str(matrix.get("head_sha") or "")
    if matrix.get("schema_version") != 1: errors.append("attack matrix schema_version must be 1")
    if not SHA_RE.match(head_sha): errors.append("attack matrix head_sha is invalid")
    required:set[str]=set()
    for obligation in closure.get("obligations") or []:
        if isinstance(obligation,dict) and obligation.get("disposition")=="covered": required.update(str(v) for v in obligation.get("requirement_ids") or [])
    entries=matrix.get("requirements") or []; by_id={str(i.get("requirement_id")):i for i in entries if isinstance(i,dict)}
    missing=sorted(required-set(by_id))
    if missing: errors.append(f"attack matrix does not cover requirements: {missing}")
    if matrix.get("uncovered_requirements"): errors.append("attack matrix has uncovered_requirements")
    for rid in sorted(required & set(by_id)):
        item=by_id[rid]
        validate_specific_text(item.get("plausible_wrong_implementation"), f"requirement {rid} plausible_wrong_implementation", errors, minimum_chars=20, minimum_words=6)
        families={str(v) for v in item.get("risk_families") or []}
        if not families: errors.append(f"requirement {rid} has no risk families")
        surfaces=declared_surfaces(item,families,errors,rid)
        if not surfaces: errors.append(f"requirement {rid} has no risk_surfaces")
        require_overlap(item.get("plausible_wrong_implementation"), surface_context_terms(item), f"requirement {rid} plausible_wrong_implementation", errors)
        declared_surface_names={s for _,s in surfaces}; omitted_detected=sorted(inferred_surfaces(item,families)-declared_surface_names)
        if omitted_detected: errors.append(f"requirement {rid} omits inferred risk surfaces: {omitted_detected}")
        validate_basic_control(item.get("positive_control"),head_sha,f"requirement {rid} positive control",errors)
        negative=item.get("negative_controls") or []
        if not negative: errors.append(f"requirement {rid} has no negative controls")
        sibling_min=2 if HIGH_RISK.intersection(families) else 1; covered:set[tuple[str,str,str]]=set(); primary:set[tuple[str,str]]=set()
        for index,control in enumerate(negative):
            covered.update(validate_negative_control(control,head_sha,f"requirement {rid} negative control {index}",families,surfaces,errors,sibling_min))
            if isinstance(control,dict): primary.add((str(control.get("risk_family") or ""),str(control.get("surface") or "")))
        missing_surfaces=sorted(f"{f}:{s}" for f,s in surfaces-primary)
        if missing_surfaces: errors.append(f"requirement {rid} has risk surfaces without adversarial coverage: {missing_surfaces}")
        if HIGH_RISK.intersection(families) and len(surfaces)>1 and len({s for _,s,_ in covered})<2: errors.append(f"requirement {rid} high-risk controls do not cross surfaces")
        regression=item.get("regression_controls") or []
        if not regression: errors.append(f"requirement {rid} has no regression controls")
        for index,control in enumerate(regression): validate_basic_control(control,head_sha,f"requirement {rid} regression control {index}",errors)
    if errors:
        for error in errors: print(f"BLOCK: {error}")
        return 2
    print("READY: every covered requirement has semantically bound adversarial and regression evidence")
    return 0

if __name__ == "__main__": raise SystemExit(main())
