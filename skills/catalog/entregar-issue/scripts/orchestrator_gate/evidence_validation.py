from __future__ import annotations

import itertools
import json
from pathlib import Path
from typing import Any

from .utils import is_nonempty, load_json, resolve, sha256_file, text
from .schema_validation import validate_against_schema
from .visual_validation import validate_visual_metrics

RUNTIME_TYPES = {
    "command", "api-call", "boundary-call", "persistence", "manual", "visual",
    "visual-accessibility", "fault-injection", "negative-control", "mutation",
    "counterexample", "dependency-outage", "persistence-boundary",
}
DISCRIMINANT_TYPES = {
    "boundary-call", "fault-injection", "negative-control", "mutation", "counterexample",
    "dependency-outage", "persistence-boundary", "visual-accessibility",
}


def required_families(risk: dict[str, Any]) -> set[str]:
    required = {"F01", "F02", "F15"}
    if risk.get("multi_entity"):
        required.update({"F03", "F04", "F05"})
    if risk.get("multi_step"):
        required.update({"F06", "F07"})
    if risk.get("persistence"):
        required.update({"F09", "F10", "F11"})
        if risk.get("multi_step"):
            required.add("F08")
    if len(risk.get("multiple_entrypoints") or []) > 1:
        required.add("F12")
    if risk.get("data_migration") or risk.get("fallback_paths"):
        required.add("F13")
    if risk.get("authorization") or risk.get("privacy"):
        required.add("F14")
    if risk.get("visual"):
        required.add("F16")
    if (risk.get("authorization") or risk.get("privacy")) and risk.get("persistence"):
        required.update({"F17", "F18"})
    if risk.get("persistence"):
        required.add("F19")
    if risk.get("authorization") or risk.get("privacy"):
        required.add("F20")
    if risk.get("persistence"):
        required.add("F21")
    if risk.get("data_migration"):
        required.add("F22")
    if (risk.get("authorization") or risk.get("privacy")) and risk.get("persistence"):
        required.add("F23")
    if risk.get("visual") and risk.get("multi_step"):
        required.add("F24")
    if risk.get("read_model_closure"):
        required.add("F25")
    if risk.get("canonical_source_consistency"):
        required.add("F26")
    if risk.get("documentation_contract_transition"):
        required.add("F27")
    if risk.get("runtime_policy"):
        required.update({"F28", "F29"})
    if risk.get("adapter_contract"):
        required.add("F30")
    if risk.get("request_translation"):
        required.add("F31")
    if risk.get("legacy_compatibility"):
        required.add("F32")
    if risk.get("documentation_claims"):
        required.add("F33")
    if risk.get("input_parser"):
        required.add("F34")
    return required



def validate_input_parser_contract(
    risk: dict[str, Any],
    scenarios: list[dict[str, Any]],
    evidence_by_id: dict[str, dict[str, Any]],
    errors: list[str],
) -> None:
    if not risk.get("input_parser"):
        return

    contract = risk.get("input_parser_contract")
    if not isinstance(contract, dict):
        errors.append("F34 input_parser_contract is required")
        return

    def string_set(field: str, minimum: int = 1) -> set[str]:
        values = contract.get(field) or []
        if not isinstance(values, list):
            errors.append(f"F34 {field} must be a list")
            return set()
        normalized = {value.strip() for value in values if isinstance(value, str) and value.strip()}
        if len(normalized) < minimum:
            errors.append(f"F34 {field} requires at least {minimum} item(s)")
        if len(normalized) != len(values):
            errors.append(f"F34 {field} contains blank or duplicate items")
        return normalized

    modes = string_set("accepted_modes")
    invariants = string_set("structural_invariants")
    consumed_fields = string_set("consumed_fields")
    placements = string_set("field_scope_placements")
    stages = string_set("raw_boundary_stages", 4)
    boundary_cases = string_set("raw_boundary_cases", 9)
    error_cases = string_set("error_precedence_cases", 2)
    control_ids = string_set("control_ids", 5)

    required_controls = {"IP-RAW-001", "IP-MODE-001", "IP-SCOPE-001", "IP-INACTIVE-001", "IP-EFFECT-001"}
    if not required_controls.issubset(control_ids):
        errors.append(f"F34 control_ids misses: {sorted(required_controls-control_ids)}")

    required_boundary_cases = {
        "missing", "empty", "whitespace-only", "exact-limit", "limit-plus-one",
        "valid-plus-external-padding-over-limit", "over-limit-before-transformation",
        "representation-changing-transform", "invalid-encoding-or-header",
    }
    if not required_boundary_cases.issubset(boundary_cases):
        errors.append(f"F34 raw_boundary_cases misses: {sorted(required_boundary_cases-boundary_cases)}")

    def validate_matrix(field: str, dimensions: tuple[tuple[str, set[str]], ...], key_builder) -> set[str]:
        matrix = contract.get(field) or []
        if not isinstance(matrix, list):
            errors.append(f"F34 {field} must be a list")
            matrix = []
        by_key: dict[str, dict[str, Any]] = {}
        for index, item in enumerate(matrix):
            if not isinstance(item, dict):
                errors.append(f"F34 {field}[{index}] invalid")
                continue
            values: list[str] = []
            for dimension, allowed in dimensions:
                value = item.get(dimension)
                if not isinstance(value, str) or value not in allowed:
                    errors.append(f"F34 {field}[{index}] references unknown {dimension}")
                    values = []
                    break
                values.append(value)
            if not values:
                continue
            key = key_builder(*values)
            if key in by_key:
                errors.append(f"F34 duplicate {field} cell: {key}")
                continue
            required = item.get("required")
            if not isinstance(required, bool):
                errors.append(f"F34 {field} cell {key} requires boolean required")
            if required is False and (not isinstance(item.get("rationale"), str) or len(item.get("rationale", "").strip()) < 8):
                errors.append(f"F34 non-required {field} cell {key} requires substantive rationale")
            by_key[key] = item
        expected = {key_builder(*values) for values in itertools.product(*(allowed for _, allowed in dimensions))}
        if set(by_key) != expected:
            errors.append(f"F34 {field} is incomplete or extra; missing={sorted(expected-set(by_key))}, extra={sorted(set(by_key)-expected)}")
        return {key for key, item in by_key.items() if item.get("required") is True}

    required_pairs = validate_matrix(
        "mode_invariant_matrix",
        (("mode", modes), ("invariant", invariants)),
        lambda mode, invariant: f"{mode}::{invariant}",
    )

    hierarchical = contract.get("hierarchical")
    if hierarchical is True:
        required_placements = {"direct", "generic-container", "scalar-container"}
        if not required_placements.issubset(placements):
            errors.append(f"F34 field_scope_placements misses: {sorted(required_placements-placements)}")
    elif hierarchical is not False:
        errors.append("F34 input_parser_contract.hierarchical must be boolean")

    required_field_scope = validate_matrix(
        "mode_field_scope_matrix",
        (("mode", modes), ("field", consumed_fields), ("placement", placements)),
        lambda mode, field, placement: f"{mode}::{field}::{placement}",
    )

    f34 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F34"]
    covered_pairs = {value for item in f34 for value in item.get("mode_invariant_pairs") or [] if isinstance(value, str)}
    covered_field_scope = {value for item in f34 for value in item.get("mode_field_scope_cases") or [] if isinstance(value, str)}
    covered_stages = {value for item in f34 for value in item.get("boundary_stages") or [] if isinstance(value, str)}
    covered_boundary_cases = {value for item in f34 for value in item.get("boundary_cases") or [] if isinstance(value, str)}
    covered_error_cases = {value for item in f34 for value in item.get("error_precedence_cases") or [] if isinstance(value, str)}
    covered_controls = {value for item in f34 for value in item.get("control_ids") or [] if isinstance(value, str)}
    checks = {value for item in f34 for value in item.get("checks") or [] if isinstance(value, str)}

    if required_pairs - covered_pairs:
        errors.append(f"F34 misses required mode/invariant pairs: {sorted(required_pairs-covered_pairs)}")
    if required_field_scope - covered_field_scope:
        errors.append(f"F34 misses required mode/field/placement cases: {sorted(required_field_scope-covered_field_scope)}")
    if stages - covered_stages:
        errors.append(f"F34 misses raw boundary stages: {sorted(stages-covered_stages)}")
    if boundary_cases - covered_boundary_cases:
        errors.append(f"F34 misses raw boundary cases: {sorted(boundary_cases-covered_boundary_cases)}")
    if error_cases - covered_error_cases:
        errors.append(f"F34 misses error precedence cases: {sorted(error_cases-covered_error_cases)}")
    if required_controls - covered_controls:
        errors.append(f"F34 scenarios miss control IDs: {sorted(required_controls-covered_controls)}")

    required_checks = {
        "parser-direct-call", "public-boundary-call", "raw-input-preserved",
        "missing-empty-distinguished", "whitespace-only-domain-error",
        "exact-size-boundary", "limit-plus-one-rejected",
        "valid-plus-external-padding-rejected", "over-limit-before-transformation",
        "error-code-precedence", "identity-or-hash-representation-verified",
        "all-consumed-fields-covered", "no-side-effects-on-rejection",
    }
    if hierarchical is True:
        required_checks.update({
            "direct-scope-membership", "scalar-as-container", "unknown-wrapper",
            "inactive-content", "cross-scope-metadata", "duplicate-or-reordered-sections",
            "mode-without-declaration-or-equivalent",
        })
    if not required_checks.issubset(checks):
        errors.append(f"F34 misses checks: {sorted(required_checks-checks)}")

    f34_evidence_types = {
        evidence_by_id[ref].get("type")
        for item in f34
        for ref in item.get("evidence") or []
        if ref in evidence_by_id
    }
    if "boundary-call" not in f34_evidence_types:
        errors.append("F34 requires boundary-call evidence through the public boundary")
    if not f34_evidence_types & (DISCRIMINANT_TYPES - {"boundary-call"}):
        errors.append("F34 requires discriminant counterexample or negative-control evidence in addition to boundary-call")

def validate_evidence(data: dict[str, Any], packet: Path, context_files: list[dict], risk: dict, evidence_dir: Path, errors: list[str]) -> dict[str, int]:
    head = data.get("head_sha")
    evidence_items = data.get("evidence") or []
    if not isinstance(evidence_items, list) or not evidence_items:
        errors.append("evidence must contain items")
        evidence_items = []
    evidence_by_id: dict[str, dict] = {}
    for index, item in enumerate(evidence_items):
        if not isinstance(item, dict):
            errors.append(f"evidence[{index}] invalid")
            continue
        eid = text(item.get("id"), f"evidence[{index}].id", errors)
        etype = text(item.get("type"), f"evidence[{eid}].type", errors)
        text(item.get("claim"), f"evidence[{eid}].claim", errors, 12)
        if eid in evidence_by_id:
            errors.append(f"duplicate evidence id: {eid}")
        evidence_by_id[eid] = item
        if etype in {"code", "test", "doc"}:
            target = resolve(Path(str(data.get("repository_path", ""))), str(item.get("path", "")))
            if not target.exists():
                errors.append(f"evidence {eid}: referenced file missing")
        if etype in RUNTIME_TYPES:
            output = resolve(evidence_dir, str(item.get("output_path", "")))
            if not is_nonempty(output):
                errors.append(f"evidence {eid}: output missing or empty")
            if etype not in {"manual", "visual"}:
                text(item.get("command"), f"evidence {eid}.command", errors, 4)
                if not isinstance(item.get("exit_code"), int):
                    errors.append(f"evidence {eid}: exit_code required")
                if item.get("expected_exit") is not None and item.get("exit_code") != item.get("expected_exit"):
                    errors.append(f"evidence {eid}: exit_code differs from expected_exit")
            if etype in {"negative-control", "mutation", "counterexample", "fault-injection", "dependency-outage"}:
                if item.get("restored") is not True or item.get("clean_head_after") != head:
                    errors.append(f"evidence {eid}: adversarial state was not restored to frozen SHA")
            if etype in {"dependency-outage", "persistence-boundary"}:
                if item.get("uses_real_adapter") is not True or item.get("environment") != "production":
                    errors.append(f"evidence {eid}: real adapter in production environment required")
            if etype == "visual-accessibility":
                metrics = load_json(resolve(evidence_dir, str(item.get("metrics_path", ""))), f"visual metrics {eid}", errors)
                if metrics:
                    validate_against_schema(
                        metrics,
                        Path(__file__).resolve().parents[2] / "schemas" / "visual-metrics.schema.json",
                        f"visual metrics {eid}",
                        errors,
                    )
                    validate_visual_metrics(metrics, str(head), risk.get("visual_contract") or {}, errors)

    requirements = data.get("requirements") or []
    if not isinstance(requirements, list) or not requirements:
        errors.append("requirements must contain atomic requirements")
        requirements = []
    req_ids: set[str] = set()
    essential: set[str] = set()
    for index, req in enumerate(requirements):
        if not isinstance(req, dict):
            errors.append(f"requirements[{index}] invalid")
            continue
        rid = text(req.get("id"), f"requirements[{index}].id", errors)
        if rid in req_ids:
            errors.append(f"duplicate requirement id: {rid}")
        req_ids.add(rid)
        if req.get("essential") is True:
            essential.add(rid)
        if req.get("status") != "verified":
            errors.append(f"requirement {rid}: status must be verified")
        refs = req.get("evidence") or []
        if not isinstance(refs, list) or len(set(refs)) < 2:
            errors.append(f"requirement {rid}: at least two distinct evidence items required")
            refs = []
        types = {evidence_by_id[ref].get("type") for ref in refs if ref in evidence_by_id}
        if any(ref not in evidence_by_id for ref in refs):
            errors.append(f"requirement {rid}: missing evidence references")
        if req.get("essential") is True:
            if not types & RUNTIME_TYPES:
                errors.append(f"essential requirement {rid}: runtime evidence missing")
            if not types & DISCRIMINANT_TYPES:
                errors.append(f"essential requirement {rid}: discriminant evidence missing")
            if not (req.get("wrong_implementations") or []):
                errors.append(f"essential requirement {rid}: plausible wrong implementation missing")
            if not (req.get("scenario_cases") or []):
                errors.append(f"essential requirement {rid}: scenario missing")

    wrong = data.get("wrong_implementations") or []
    wrong_by_id: dict[str, dict] = {}
    if not isinstance(wrong, list):
        errors.append("wrong_implementations must be list")
        wrong = []
    for index, item in enumerate(wrong):
        if not isinstance(item, dict):
            errors.append(f"wrong_implementations[{index}] invalid")
            continue
        wid = text(item.get("id"), f"wrong_implementations[{index}].id", errors)
        if wid in wrong_by_id:
            errors.append(f"duplicate wrong implementation id: {wid}")
        text(item.get("description"), f"wrong implementation {wid}.description", errors, 20)
        if item.get("status") != "refuted":
            errors.append(f"wrong implementation {wid}: must be refuted")
        requirement_refs = item.get("requirement_ids") or []
        if not isinstance(requirement_refs, list) or not requirement_refs or not set(requirement_refs).issubset(req_ids):
            errors.append(f"wrong implementation {wid}: invalid requirement IDs")
        wrong_evidence = item.get("evidence") or []
        if not isinstance(wrong_evidence, list) or not wrong_evidence:
            errors.append(f"wrong implementation {wid}: evidence is required")
        elif any(ref not in evidence_by_id for ref in wrong_evidence):
            errors.append(f"wrong implementation {wid}: invalid evidence")
        wrong_by_id[wid] = item

    for req in requirements:
        if not isinstance(req, dict) or req.get("essential") is not True:
            continue
        rid = req.get("id")
        for wid in req.get("wrong_implementations") or []:
            wrong_item = wrong_by_id.get(wid)
            if not wrong_item:
                errors.append(f"requirement {rid}: unknown wrong implementation {wid}")
            elif rid not in (wrong_item.get("requirement_ids") or []):
                errors.append(f"requirement {rid}: wrong implementation {wid} does not link back")

    scenarios = data.get("scenarios") or []
    scenario_by_id: dict[str, dict] = {}
    if not isinstance(scenarios, list):
        errors.append("scenarios must be list")
        scenarios = []
    for index, item in enumerate(scenarios):
        if not isinstance(item, dict):
            errors.append(f"scenarios[{index}] invalid")
            continue
        sid = text(item.get("id"), f"scenarios[{index}].id", errors)
        if sid in scenario_by_id:
            errors.append(f"duplicate scenario id: {sid}")
        text(item.get("description"), f"scenario {sid}.description", errors, 15)
        if item.get("result") != "passed":
            errors.append(f"scenario {sid}: result must be passed")
        scenario_requirements = item.get("requirement_ids") or []
        if not isinstance(scenario_requirements, list) or not scenario_requirements or not set(scenario_requirements).issubset(req_ids):
            errors.append(f"scenario {sid}: invalid requirement IDs")
        scenario_evidence = item.get("evidence") or []
        if not isinstance(scenario_evidence, list) or not scenario_evidence:
            errors.append(f"scenario {sid}: evidence is required")
        elif any(ref not in evidence_by_id for ref in scenario_evidence):
            errors.append(f"scenario {sid}: invalid evidence")
        scenario_by_id[sid] = item

    for req in requirements:
        if not isinstance(req, dict):
            continue
        rid = req.get("id")
        for sid in req.get("scenario_cases") or []:
            scenario = scenario_by_id.get(sid)
            if not scenario:
                errors.append(f"requirement {rid}: unknown scenario {sid}")
            elif rid not in (scenario.get("requirement_ids") or []):
                errors.append(f"requirement {rid}: scenario {sid} does not link back")

    families = data.get("scenario_families") or []
    if not isinstance(families, list):
        errors.append("scenario_families must be list")
        families = []
    family_by_id: dict[str, dict] = {}
    for index, item in enumerate(families):
        if not isinstance(item, dict):
            errors.append(f"scenario_families[{index}] invalid")
            continue
        fid = text(item.get("id"), f"scenario_families[{index}].id", errors)
        if fid in family_by_id:
            errors.append(f"duplicate scenario family id: {fid}")
        family_by_id[fid] = item
    mandatory = required_families(risk)
    for fid in mandatory:
        family = family_by_id.get(fid)
        if not family or family.get("applicable") is not True:
            errors.append(f"mandatory family missing or not applicable: {fid}")
            continue
        cases = family.get("cases") or []
        if not cases:
            errors.append(f"mandatory family {fid}: no cases")
        for sid in cases:
            if sid not in scenario_by_id or scenario_by_id[sid].get("family_id") != fid:
                errors.append(f"mandatory family {fid}: invalid scenario {sid}")
    for sid, scenario in scenario_by_id.items():
        fid = scenario.get("family_id")
        family = family_by_id.get(fid)
        if not family:
            errors.append(f"scenario {sid}: unknown family {fid}")
        elif sid not in (family.get("cases") or []):
            errors.append(f"scenario {sid}: family {fid} does not link back")

    passes = data.get("passes") or {}
    pass_a = passes.get("pass_a") or {}
    pass_b = passes.get("pass_b") or {}
    if pass_a.get("status") != "passed" or set(pass_a.get("requirement_ids") or []) != req_ids:
        errors.append("Pass A must pass and cover exactly all requirements")
    pass_a_evidence = pass_a.get("evidence") or []
    if not isinstance(pass_a_evidence, list) or not pass_a_evidence:
        errors.append("Pass A must contain evidence")
    elif any(ref not in evidence_by_id for ref in pass_a_evidence):
        errors.append("Pass A references invalid evidence")
    if pass_b.get("status") != "passed":
        errors.append("Pass B must be passed")
    pass_b_evidence = pass_b.get("evidence") or []
    if not isinstance(pass_b_evidence, list) or not pass_b_evidence:
        errors.append("Pass B must contain evidence")
    elif any(ref not in evidence_by_id for ref in pass_b_evidence):
        errors.append("Pass B references invalid evidence")
    plan_path = resolve(evidence_dir, str(pass_b.get("plan_path", "")))
    plan = load_json(plan_path, "Pass B plan", errors)
    if plan and pass_b.get("plan_sha256") != sha256_file(plan_path):
        errors.append("Pass B plan hash mismatch")
    if plan:
        if plan.get("schema_version") != 3:
            errors.append("Pass B plan schema_version must be 3")
        if plan.get("created_before_tests_inspection") is not True:
            errors.append("Pass B plan must predate tests inspection")
        forbidden_tokens = {"tests.patch", "pr-description", "pull-request-body", "implementation-summary", "prior-audit"}
        source_materials = [str(value).strip().lower() for value in plan.get("source_materials") or []]
        required_sources = {"issue.md", "specification-snapshot.json", "specification-sources/", "production.patch", "production_context_files.json", "dependency_edges.json", "runtime_graph_coverage.json", "risk_detection.json", "production-context/"}
        missing_sources = sorted(required_sources - set(source_materials))
        if missing_sources:
            errors.append(f"Pass B plan omits neutral sources: {missing_sources}")
        forbidden = {str(value).lower() for value in plan.get("forbidden_sources_used") or []}
        forbidden.update(source for source in source_materials if any(token in source for token in forbidden_tokens))
        if forbidden:
            errors.append(f"Pass B used forbidden sources: {sorted(forbidden)}")
        if plan.get("packet_path") != str(packet):
            errors.append("Pass B packet_path differs from gate packet")
        expected_context = {str(item.get("path")) for item in context_files if item.get("path")}
        reviewed = set(plan.get("reviewed_runtime_context_files") or [])
        if expected_context - reviewed:
            errors.append(f"Pass B did not review all runtime context: {sorted(expected_context-reviewed)[:20]}")
        unchanged = {str(item.get("path")) for item in context_files if item.get("path") and item.get("changed") is False}
        if unchanged and not (plan.get("unchanged_dependency_risks") or []):
            errors.append("Pass B must record risks from unchanged runtime dependencies")
        reverse_callers = {str(item.get("path")) for item in context_files if item.get("relation") == "caller"}
        if reverse_callers and not (plan.get("reverse_caller_risks") or []):
            errors.append("Pass B must record risks from reverse callers")
        if risk.get("persistence") and not (plan.get("persistence_boundary_blueprints") or []):
            errors.append("Pass B must plan real-adapter outage scenarios for persistence boundaries")
        if any(risk.get(field) for field in ("runtime_policy", "adapter_contract", "request_translation", "legacy_compatibility", "documentation_claims")) and not (plan.get("runtime_contract_blueprints") or []):
            errors.append("Pass B must plan runtime contract scenarios for F28-F33")
        if risk.get("input_parser") and not (plan.get("input_parser_blueprints") or []):
            errors.append("Pass B must plan input parser scenarios for F34")
        if len(plan.get("hypotheses") or []) < 3 or len(plan.get("scenario_blueprints") or []) < 3:
            errors.append("Pass B plan requires three hypotheses and three scenario blueprints")

    auth_persistent = bool((risk.get("authorization") or risk.get("privacy")) and risk.get("persistence"))
    critical_families = required_families(risk) & {"F20", "F21", "F22", "F23", "F24", "F25", "F26", "F27", "F28", "F29", "F30", "F31", "F32", "F33", "F34"}
    minimum_novel = max(
        len(critical_families),
        5 if auth_persistent else 4 if risk.get("persistence") or risk.get("input_parser") or any(risk.get(field) for field in ("runtime_policy", "adapter_contract", "request_translation", "legacy_compatibility", "documentation_claims")) else 3,
    )
    novel = pass_b.get("novel_scenarios") or []
    if len(set(novel)) < minimum_novel:
        errors.append(f"Pass B requires at least {minimum_novel} novel scenarios")
    novel_families = set()
    for sid in novel:
        scenario = scenario_by_id.get(sid)
        if not scenario:
            errors.append(f"Pass B references unknown scenario {sid}")
            continue
        if scenario.get("novel") is not True or scenario.get("source") != "contract-derived":
            errors.append(f"Pass B scenario {sid} must be novel and contract-derived")
        novel_families.add(scenario.get("family_id"))
    if len(novel_families) < (4 if auth_persistent else 2):
        errors.append("Pass B attacks too few adversarial families")
    if auth_persistent and not {"F17", "F18"}.issubset(novel_families):
        errors.append("persistent authorization Pass B must include F17 and F18")
    if risk.get("persistence") and "F19" not in novel_families:
        errors.append("persistence Pass B must include F19")
    if not critical_families.issubset(novel_families):
        errors.append(
            f"Pass B misses critical families: {sorted(critical_families-novel_families)}"
        )

    unresolved_findings = [item.get("id") for item in data.get("findings") or [] if isinstance(item, dict) and item.get("status") != "resolved-and-reverified"]
    if unresolved_findings:
        errors.append(f"unresolved findings: {unresolved_findings}")
    for item in data.get("later_findings_imported") or []:
        if not isinstance(item, dict):
            errors.append("later finding invalid")
            continue
        if item.get("status") != "resolved-and-reverified":
            errors.append(f"later finding {item.get('id')} not reverified")
        escape_to_gate = {
            "execution-state-gap": "F28",
            "control-propagation-gap": "F29",
            "capability-operation-drift": "F30",
            "adapter-support-drift": "F30",
            "silent-translation-loss": "F31",
            "legacy-variant-gap": "F32",
            "documentation-claim-drift": "F33",
            "parser-mode-gap": "F34",
            "boundary-normalization-gap": "F34",
            "validation-order-gap": "F34",
            "scope-membership-gap": "F34",
        }
        escape_category = item.get("escape_category")
        if escape_category in escape_to_gate and item.get("required_gate") != escape_to_gate[escape_category]:
            errors.append(f"later finding {item.get('id')} maps {escape_category} to {escape_to_gate[escape_category]}")
        if escape_category in escape_to_gate and item.get("required_gate") not in novel_families:
            errors.append(f"later finding {item.get('id')} requires a novel scenario in {item.get('required_gate')}")
        if not item.get("literal_scenarios") or len(set(item.get("sibling_scenarios") or [])) < 2:
            errors.append(f"later finding {item.get('id')} requires literal and two sibling scenarios")
        all_scenarios = [*(item.get("literal_scenarios") or []), *(item.get("sibling_scenarios") or [])]
        if any(sid not in scenario_by_id for sid in all_scenarios):
            errors.append(f"later finding {item.get('id')} references unknown scenarios")
        finding_evidence = item.get("evidence") or []
        if not isinstance(finding_evidence, list) or not finding_evidence or any(ref not in evidence_by_id for ref in finding_evidence):
            errors.append(f"later finding {item.get('id')} requires valid evidence")

    validation_commands = data.get("validation_commands") or []
    if not isinstance(validation_commands, list) or not validation_commands:
        errors.append("validation_commands must contain final commands")
        validation_commands = []
    for index, command in enumerate(validation_commands):
        if not isinstance(command, dict):
            errors.append(f"validation command {index} is invalid")
            continue
        text(command.get("command"), f"validation command {index}.command", errors, 4)
        if command.get("exit_code") != 0:
            errors.append(f"validation command {index} failed or invalid")
        output = resolve(evidence_dir, str(command.get("output_path", "")))
        if not is_nonempty(output):
            errors.append(f"validation command {index} output missing")

    # Cross-entrypoint, authorization and fault-injection checks.
    entrypoints = risk.get("multiple_entrypoints") or []
    if len(entrypoints) > 1:
        covered = {value for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F12" for value in item.get("entrypoints") or []}
        missing = sorted(set(entrypoints) - covered)
        if missing:
            errors.append(f"F12 does not cover entrypoints: {missing}")
    if risk.get("authorization") or risk.get("privacy"):
        boundary_items = [item for item in evidence_items if isinstance(item, dict) and item.get("type") == "boundary-call"]
        if not boundary_items:
            errors.append("authorization/privacy requires boundary-call evidence")
        else:
            covered_cases = {value for item in boundary_items for value in item.get("cases") or []}
            required_cases = {"authorized", "nonexistent", "other-tenant", "ineligible"}
            if not required_cases.issubset(covered_cases):
                errors.append(f"boundary-call evidence misses cases: {sorted(required_cases-covered_cases)}")
    if risk.get("multi_step") and risk.get("persistence"):
        if not any(item.get("type") == "fault-injection" for item in evidence_items if isinstance(item, dict)):
            errors.append("multi-step persistence requires fault-injection evidence")

    # High-risk family detail checks.
    if auth_persistent:
        sources = set(risk.get("eligibility_sources") or [])
        f17 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F17"]
        covered_sources = {value for item in f17 for value in item.get("eligibility_sources") or []}
        transitions = {value for item in f17 for value in item.get("transition_cases") or []}
        if sources - covered_sources or not {"allowed-to-denied", "denied-to-allowed"}.issubset(transitions):
            errors.append("F17 does not cover all eligibility sources and transitions")
        operations = {item.get("name"): item.get("terminal_retry") for item in risk.get("transactional_authorization_operations") or [] if isinstance(item, dict)}
        f18 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F18"]
        covered_ops = {value for item in f18 for value in item.get("operations") or []}
        interleavings = {value for item in f18 for value in item.get("interleavings") or []}
        required_interleavings = {"preflight-pass-authority-loss-before-lock", "authority-loss-after-lock-before-commit"}
        if any(operations.values()):
            required_interleavings.add("terminal-retry-after-authority-loss")
        if set(operations) - covered_ops or not required_interleavings.issubset(interleavings):
            errors.append("F18 does not cover operations and required interleavings")

    if risk.get("persistence"):
        f19 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F19"]
        boundaries = {item.get("name") for item in risk.get("persistence_boundaries") or [] if isinstance(item, dict)}
        covered = {value for item in f19 for value in item.get("persistence_boundaries") or []}
        modes = {value for item in f19 for value in item.get("failure_modes") or []}
        assertions = {value for item in f19 for value in item.get("assertions") or []}
        required_modes = {"dependency-unavailable", "restart"}
        required_assertions = {"no-orphan-outbound", "no-domain-mutation"}
        if risk.get("durable_persistence_required"):
            required_modes.add("cross-instance")
            required_assertions.update({"reconstructible-after-restart", "single-effect-across-instances"})
        if boundaries - covered or not required_modes.issubset(modes) or not required_assertions.issubset(assertions):
            errors.append("F19 does not cover all boundaries, failure modes and durability assertions")
        if not any(item.get("uses_real_adapter") is True and item.get("environment") == "production" for item in f19):
            errors.append("F19 requires production scenario using real adapter")
        if not any(item.get("type") == "dependency-outage" and item.get("uses_real_adapter") is True and item.get("environment") == "production" for item in evidence_items if isinstance(item, dict)):
            errors.append("persistence requires dependency-outage evidence with real adapter")

    if risk.get("visual"):
        if not any(item.get("type") == "visual-accessibility" for item in evidence_items if isinstance(item, dict)):
            errors.append("visual impact requires visual-accessibility evidence")
        viewports = {value for item in evidence_items if isinstance(item, dict) and item.get("type") == "visual" for value in item.get("viewports") or []}
        if len(viewports) < 3:
            errors.append("visual impact requires three viewports")
        contract = risk.get("visual_contract") or {}
        repo = Path(str(data.get("repository_path", ""))).resolve()
        validator_paths = contract.get("validator_paths") or []
        workflow_paths = contract.get("workflow_paths") or []
        documentation_paths = contract.get("documentation_paths") or []
        workflow_text = "\n".join((repo / value).read_text(encoding="utf-8", errors="ignore") for value in workflow_paths if (repo / value).is_file())
        documentation_text = "\n".join((repo / value).read_text(encoding="utf-8", errors="ignore") for value in documentation_paths if (repo / value).is_file())
        for value in [*validator_paths, *workflow_paths, *documentation_paths]:
            if not (repo / value).is_file():
                errors.append(f"visual contract references missing file: {value}")
        for validator_path in validator_paths:
            if workflow_paths and validator_path not in workflow_text:
                errors.append(f"visual validator is not wired into a declared existing workflow: {validator_path}")
            if validator_path not in documentation_text:
                errors.append(f"visual validator is not documented: {validator_path}")
        f16_checks = {value for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F16" for value in item.get("checks") or []}
        required_checks = {"layout-three-viewports", "keyboard-focus", "accessibility-tree", "semantic-structure", "long-content-or-zoom"}
        if contract.get("dynamic_surfaces"):
            required_checks.update({"live-region-stability", "single-writer"})
        if contract.get("table_surfaces"):
            required_checks.add("table-row-semantics")
        if contract.get("dialog_surfaces"):
            required_checks.add("dialog-focus-cycle")
        if not required_checks.issubset(f16_checks):
            errors.append(f"F16 misses visual checks: {sorted(required_checks-f16_checks)}")

    if risk.get("authorization") or risk.get("privacy"):
        f20 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F20"]
        boundaries = {item.get("name") for item in risk.get("public_boundaries") or [] if isinstance(item, dict)}
        covered = {value for item in f20 for value in item.get("public_boundaries") or []}
        observables = {value for item in f20 for value in item.get("observables") or []}
        required_observables = {"status", "code", "body", "side-effects", "guard-order", "timing"}
        if boundaries - covered or not required_observables.issubset(observables):
            errors.append("F20 does not prove every public boundary and observable")

    if risk.get("persistence"):
        f21 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F21"]
        operations = {item.get("name") for item in risk.get("transactional_business_operations") or [] if isinstance(item, dict)}
        covered = {value for item in f21 for value in item.get("operations") or []}
        interleavings = {value for item in f21 for value in item.get("interleavings") or []}
        assertions = {value for item in f21 for value in item.get("assertions") or []}
        required_interleavings = {
            "conflict-after-preflight-before-lock",
            "source-change-after-lock-before-commit",
        }
        required_assertions = {"decision-rechecked-in-transaction", "no-partial-effects"}
        if operations - covered or not required_interleavings.issubset(interleavings) or not required_assertions.issubset(assertions):
            errors.append("F21 does not cover atomic business decisions and interleavings")

    if risk.get("data_migration"):
        f22 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F22"]
        invariants = {item.get("name") for item in risk.get("structural_invariants") or [] if isinstance(item, dict)}
        covered = {value for item in f22 for value in item.get("structural_invariants") or []}
        mutation_cases = {value for item in f22 for value in item.get("mutation_cases") or []}
        assertions = {value for item in f22 for value in item.get("assertions") or []}
        required_cases = {"direct-write", "referenced-target-update", "concurrent-write", "legacy-backfill"}
        if invariants - covered or not required_cases.issubset(mutation_cases) or "global-postcondition" not in assertions:
            errors.append("F22 does not prove relational invariants across writes and backfill")

    if auth_persistent:
        f23 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F23"]
        sources = {item.get("name") for item in risk.get("freshness_sources") or [] if isinstance(item, dict)}
        covered = {value for item in f23 for value in item.get("freshness_sources") or []}
        transitions = {value for item in f23 for value in item.get("transition_cases") or []}
        assertions = {value for item in f23 for value in item.get("assertions") or []}
        required_transitions = {
            "stale-version-present", "reviewed-source-changed",
            "concurrent-freshness-loss", "current-version-accepted",
        }
        if sources - covered or not required_transitions.issubset(transitions) or "review-invalidated" not in assertions:
            errors.append("F23 does not prove current versions and review invalidation")

    if risk.get("visual") and risk.get("multi_step"):
        f24 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F24"]
        transitions = {item.get("name") for item in risk.get("stateful_ui_transitions") or [] if isinstance(item, dict)}
        covered = {value for item in f24 for value in item.get("transitions") or []}
        checks = {value for item in f24 for value in item.get("checks") or []}
        permission_cases = {value for item in f24 for value in item.get("permission_cases") or []}
        required_checks = {
            "review-field-inventory", "confirmation", "next-actions",
            "reload-persistence", "terminal-discoverability",
        }
        required_permissions = {"specific-permission-link", "minimal-read-for-action"}
        if transitions - covered or not required_checks.issubset(checks) or not required_permissions.issubset(permission_cases):
            errors.append("F24 does not prove complete review and terminal transition behavior")

    if risk.get("runtime_policy"):
        f28 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F28"]
        boundaries = {item.get("name") for item in risk.get("execution_state_boundaries") or [] if isinstance(item, dict)}
        covered = {value for item in f28 for value in item.get("boundaries") or []}
        checks = {value for item in f28 for value in item.get("checks") or []}
        required_checks = {"ready-primary-call", "degraded-primary-only", "disabled-zero-outbound", "invalid-zero-outbound"}
        if boundaries - covered or not required_checks.issubset(checks):
            errors.append("F28 does not prove execution eligibility and zero outbound for blocked states")

        f29 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F29"]
        paths = {item.get("name") for item in risk.get("control_propagation_paths") or [] if isinstance(item, dict)}
        covered_paths = {value for item in f29 for value in item.get("control_paths") or []}
        propagation_checks = {value for item in f29 for value in item.get("checks") or []}
        required_propagation = {"signal-created", "adapter-contract-receives", "implementation-propagates", "sdk-receives", "settles-before-next-call"}
        if paths - covered_paths or not required_propagation.issubset(propagation_checks):
            errors.append("F29 does not prove control propagation from executor to SDK")

    if risk.get("adapter_contract"):
        f30 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F30"]
        mappings = {item.get("name") for item in risk.get("capability_operation_mappings") or [] if isinstance(item, dict)}
        covered = {value for item in f30 for value in item.get("capability_mappings") or []}
        checks = {value for item in f30 for value in item.get("checks") or []}
        required_checks = {"consumer-request-derived", "adapter-method-exists", "implementation-exists", "integration-test", "unsupported-local-rejection"}
        if mappings - covered or not required_checks.issubset(checks):
            errors.append("F30 does not close capability operations against adapter methods and consumers")

    if risk.get("request_translation"):
        f31 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F31"]
        mappings = {item.get("name") for item in risk.get("request_translation_mappings") or [] if isinstance(item, dict)}
        covered = {value for item in f31 for value in item.get("translation_mappings") or []}
        checks = {value for item in f31 for value in item.get("checks") or []}
        required_checks = {"supported-translated", "unsupported-rejected-pre-network", "zero-sdk-call-on-rejection"}
        if mappings - covered or not required_checks.issubset(checks):
            errors.append("F31 does not prove fail-closed request translation")

    if risk.get("legacy_compatibility"):
        f32 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F32"]
        matrix = {item.get("name") for item in risk.get("legacy_compatibility_matrix") or [] if isinstance(item, dict)}
        covered = {value for item in f32 for value in item.get("legacy_consumers") or []}
        checks = {value for item in f32 for value in item.get("checks") or []}
        required_checks = {"entrypoint-real", "variant-specific", "baseline-comparison"}
        if matrix - covered or not required_checks.issubset(checks):
            errors.append("F32 does not prove legacy compatibility by consumer variant")

    if risk.get("documentation_claims"):
        f33 = [item for item in scenarios if isinstance(item, dict) and item.get("family_id") == "F33"]
        claims = {item.get("name") for item in risk.get("documentation_claim_inventory") or [] if isinstance(item, dict)}
        covered = {value for item in f33 for value in item.get("documentation_claims") or []}
        checks = {value for item in f33 for value in item.get("checks") or []}
        required_checks = {"document-to-runtime", "runtime-to-test", "discriminant-negative-control"}
        if claims - covered or not required_checks.issubset(checks):
            errors.append("F33 does not prove normative documentation claims against runtime")

    validate_input_parser_contract(risk, scenarios, evidence_by_id, errors)

    return {
        "requirements": len(req_ids),
        "essential_requirements": len(essential),
        "evidence": len(evidence_by_id),
        "scenarios": len(scenario_by_id),
        "mandatory_families": len(mandatory),
    }
