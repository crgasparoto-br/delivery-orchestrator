from __future__ import annotations

from pathlib import Path
from typing import Any

from .utils import load_json, resolve, sha256_file, text
from .visual_validation import validate_visual_contract

BOOLEAN_FIELDS = {
    "multi_entity", "multi_step", "persistence", "durable_persistence_required",
    "authorization", "privacy", "visual", "data_migration", "fallback_paths",
    "documentation_impact", "read_model_closure", "canonical_source_consistency",
    "documentation_contract_transition", "runtime_policy", "adapter_contract",
    "request_translation", "legacy_compatibility", "documentation_claims",
    "audit_packet_published", "input_parser",
}
ALLOWED_DURABILITY = {
    "durable-before-outbound", "durable-before-mutation", "best-effort", "ephemeral-allowed",
}


def _text_list(value: Any, label: str, errors: list[str], *, required: bool = False) -> list[str]:
    if not isinstance(value, list) or (required and not value) or any(not isinstance(item, str) or not item.strip() for item in value):
        errors.append(f"{label} must be {'a non-empty ' if required else 'a '}list of texts")
        return []
    normalized = [item.strip() for item in value]
    if len(normalized) != len(set(normalized)):
        errors.append(f"{label} contains duplicates")
    return normalized


def _object_inventory(
    value: Any,
    label: str,
    errors: list[str],
    *,
    required: bool,
    text_fields: tuple[str, ...],
    list_fields: tuple[str, ...],
    minimum_list_sizes: dict[str, int] | None = None,
) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list):
        errors.append(f"{label} must be a list")
        return {}
    if required and not value:
        errors.append(f"{label} must be non-empty")
    minimum_list_sizes = minimum_list_sizes or {}
    result: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            errors.append(f"{label}[{index}] must be an object")
            continue
        name = text(item.get("name"), f"{label}[{index}].name", errors)
        if name in result:
            errors.append(f"{label} contains duplicate name: {name}")
        for field in text_fields:
            text(item.get(field), f"{label}[{index}].{field}", errors)
        for field in list_fields:
            values = _text_list(
                item.get(field),
                f"{label}[{index}].{field}",
                errors,
                required=minimum_list_sizes.get(field, 0) > 0,
            )
            if len(values) < minimum_list_sizes.get(field, 0):
                errors.append(
                    f"{label}[{index}].{field} requires at least "
                    f"{minimum_list_sizes[field]} values"
                )
        if name:
            result[name] = item
    return result


def validate_risk(data: dict[str, Any], packet: Path, evidence_dir: Path, errors: list[str]) -> dict[str, Any]:
    risk = data.get("risk_profile")
    if not isinstance(risk, dict):
        errors.append("risk_profile missing")
        risk = {}
    for field in BOOLEAN_FIELDS:
        if not isinstance(risk.get(field), bool):
            errors.append(f"risk_profile.{field} must be boolean")

    detection_ref = data.get("risk_detection") or {}
    detection_path = resolve(evidence_dir, str(detection_ref.get("path") or packet / "risk_detection.json"))
    detection = load_json(detection_path, "risk detection", errors)
    if detection and detection_ref.get("sha256") and detection_ref.get("sha256") != sha256_file(detection_path):
        errors.append("risk detection hash mismatch")

    overrides = data.get("risk_overrides") or []
    if not isinstance(overrides, list):
        errors.append("risk_overrides must be list")
        overrides = []
    override_by_field: dict[str, dict] = {}
    for index, item in enumerate(overrides):
        if not isinstance(item, dict):
            errors.append(f"risk_overrides[{index}] must be object")
            continue
        field = text(item.get("field"), f"risk_overrides[{index}].field", errors)
        if field in override_by_field:
            errors.append(f"duplicate risk override: {field}")
        if field not in BOOLEAN_FIELDS | {"multiple_entrypoints"}:
            errors.append(f"risk override references unsupported field: {field}")
        text(item.get("rationale"), f"risk_overrides[{index}].rationale", errors, 30)
        if "declared_value" not in item:
            errors.append(f"risk override {field}: declared_value required")
        evidence = item.get("evidence") or []
        if not isinstance(evidence, list) or not evidence:
            errors.append(f"risk override {field}: evidence required")
        else:
            for raw in evidence:
                if not isinstance(raw, str) or not resolve(evidence_dir, raw).is_file():
                    errors.append(f"risk override {field}: evidence file missing: {raw!r}")
        override_by_field[field] = item

    detected_flags = detection.get("flags") or {}
    high = detection.get("high_confidence") or {}
    for field in BOOLEAN_FIELDS - {"audit_packet_published", "multi_entity"}:
        if high.get(field) and detected_flags.get(field) is True and risk.get(field) is not True:
            override = override_by_field.get(field)
            if not override or override.get("declared_value") is not False:
                errors.append(f"risk profile understates high-confidence detection: {field}")

    detected_entrypoints = detected_flags.get("multiple_entrypoints") or []
    declared_entrypoints = _text_list(risk.get("multiple_entrypoints"), "risk_profile.multiple_entrypoints", errors)
    if len(detected_entrypoints) > 1 and not set(detected_entrypoints).issubset(set(declared_entrypoints)):
        override = override_by_field.get("multiple_entrypoints")
        if not override or override.get("declared_value") != declared_entrypoints:
            errors.append("risk profile omits detected entrypoints")

    repo = Path(str(data.get("repository_path") or "")).resolve()
    boundaries_raw = risk.get("persistence_boundaries")
    boundaries: dict[str, dict[str, Any]] = {}
    if not isinstance(boundaries_raw, list):
        errors.append("risk_profile.persistence_boundaries must be a list")
        boundaries_raw = []
    for index, item in enumerate(boundaries_raw):
        if not isinstance(item, dict):
            errors.append(f"persistence_boundaries[{index}] must be an object")
            continue
        name = text(item.get("name"), f"persistence_boundaries[{index}].name", errors)
        if name in boundaries:
            errors.append(f"duplicate persistence boundary: {name}")
        adapter_paths = _text_list(item.get("adapter_paths"), f"persistence boundary {name}.adapter_paths", errors, required=True)
        for adapter_path in adapter_paths:
            if repo.is_dir() and not (repo / adapter_path).is_file():
                errors.append(f"persistence boundary {name}: adapter path missing: {adapter_path}")
        if item.get("durability") not in ALLOWED_DURABILITY:
            errors.append(f"persistence boundary {name}: invalid durability")
        _text_list(item.get("fallback_paths"), f"persistence boundary {name}.fallback_paths", errors)
        if name:
            boundaries[name] = item
    if risk.get("persistence") and not boundaries:
        errors.append("persistence=true requires valid persistence_boundaries")

    dependencies = _text_list(
        risk.get("external_dependencies"),
        "risk_profile.external_dependencies",
        errors,
        required=bool(risk.get("persistence") or risk.get("fallback_paths") or risk.get("runtime_policy")),
    )
    if risk.get("durable_persistence_required") and not risk.get("persistence"):
        errors.append("durable_persistence_required requires persistence=true")
    if risk.get("durable_persistence_required") and not any(
        item.get("durability") in {"durable-before-outbound", "durable-before-mutation"}
        for item in boundaries.values()
    ):
        errors.append("durable persistence requires a durable-before-outbound/mutation boundary")
    if risk.get("fallback_paths") and not risk.get("runtime_policy") and not any(item.get("fallback_paths") for item in boundaries.values()):
        errors.append("fallback_paths=true requires runtime_policy=true or a declared persistence boundary fallback")

    eligibility_sources = _text_list(risk.get("eligibility_sources"), "risk_profile.eligibility_sources", errors)
    operations_raw = risk.get("transactional_authorization_operations")
    operations: dict[str, dict[str, Any]] = {}
    if not isinstance(operations_raw, list):
        errors.append("risk_profile.transactional_authorization_operations must be a list")
        operations_raw = []
    for index, item in enumerate(operations_raw):
        if not isinstance(item, dict):
            errors.append(f"transactional_authorization_operations[{index}] must be an object")
            continue
        name = text(item.get("name"), f"transactional_authorization_operations[{index}].name", errors)
        if name in operations:
            errors.append(f"duplicate transactional authorization operation: {name}")
        if not isinstance(item.get("terminal_retry"), bool):
            errors.append(f"transactional authorization operation {name}: terminal_retry must be boolean")
        checkpoints = item.get("checkpoints")
        if checkpoints is not None:
            _text_list(checkpoints, f"transactional authorization operation {name}.checkpoints", errors, required=True)
        if name:
            operations[name] = item

    auth_persistent = bool((risk.get("authorization") or risk.get("privacy")) and risk.get("persistence"))
    if auth_persistent and not eligibility_sources:
        errors.append("persistent authorization/privacy requires valid eligibility_sources")
    if auth_persistent and not operations:
        errors.append("persistent authorization/privacy requires valid transactional_authorization_operations")

    public_boundaries = _object_inventory(
        risk.get("public_boundaries"),
        "risk_profile.public_boundaries",
        errors,
        required=bool(risk.get("authorization") or risk.get("privacy")),
        text_fields=("path",),
        list_fields=("secret_states", "guard_order"),
        minimum_list_sizes={"secret_states": 2, "guard_order": 2},
    )
    business_operations = _object_inventory(
        risk.get("transactional_business_operations"),
        "risk_profile.transactional_business_operations",
        errors,
        required=bool(risk.get("persistence")),
        text_fields=(),
        list_fields=("decision_guards", "mutable_sources", "constraints", "checkpoints"),
        minimum_list_sizes={
            "decision_guards": 1, "mutable_sources": 1,
            "constraints": 1, "checkpoints": 2,
        },
    )
    structural_invariants = _object_inventory(
        risk.get("structural_invariants"),
        "risk_profile.structural_invariants",
        errors,
        required=bool(risk.get("data_migration")),
        text_fields=("rule", "database_strategy"),
        list_fields=("entities", "mutation_paths"),
        minimum_list_sizes={"entities": 1, "mutation_paths": 2},
    )
    freshness_sources = _object_inventory(
        risk.get("freshness_sources"),
        "risk_profile.freshness_sources",
        errors,
        required=auth_persistent,
        text_fields=("current_source",),
        list_fields=("invalidation_sources",),
        minimum_list_sizes={"invalidation_sources": 1},
    )
    stateful_ui_transitions = _object_inventory(
        risk.get("stateful_ui_transitions"),
        "risk_profile.stateful_ui_transitions",
        errors,
        required=bool(risk.get("visual") and risk.get("multi_step")),
        text_fields=("from_state", "to_state", "confirmation", "discovery"),
        list_fields=("review_fields", "read_capabilities", "action_capabilities", "next_actions"),
        minimum_list_sizes={
            "review_fields": 1, "read_capabilities": 1,
            "action_capabilities": 1, "next_actions": 1,
        },
    )

    execution_state_boundaries = _object_inventory(
        risk.get("execution_state_boundaries"),
        "risk_profile.execution_state_boundaries",
        errors,
        required=bool(risk.get("runtime_policy")),
        text_fields=("executor_path",),
        list_fields=("executable_states", "blocked_states"),
        minimum_list_sizes={"executable_states": 1, "blocked_states": 1},
    )
    control_propagation_paths = _object_inventory(
        risk.get("control_propagation_paths"),
        "risk_profile.control_propagation_paths",
        errors,
        required=bool(risk.get("runtime_policy")),
        text_fields=("control", "source_path", "adapter_contract_path", "implementation_path", "sdk_call_path"),
        list_fields=(),
    )
    capability_operation_mappings = _object_inventory(
        risk.get("capability_operation_mappings"),
        "risk_profile.capability_operation_mappings",
        errors,
        required=bool(risk.get("adapter_contract")),
        text_fields=("capability",),
        list_fields=("consumers", "required_operations", "supported_adapters"),
        minimum_list_sizes={"consumers": 1, "required_operations": 1, "supported_adapters": 1},
    )
    request_translation_mappings = _object_inventory(
        risk.get("request_translation_mappings"),
        "risk_profile.request_translation_mappings",
        errors,
        required=bool(risk.get("request_translation")),
        text_fields=("field", "disposition"),
        list_fields=("adapter_paths",),
        minimum_list_sizes={"adapter_paths": 1},
    )
    for name, item in request_translation_mappings.items():
        if item.get("disposition") not in {"translated", "validated", "rejected-pre-network", "not-applicable-by-contract"}:
            errors.append(f"request translation mapping {name}: invalid disposition")
    legacy_compatibility_matrix = _object_inventory(
        risk.get("legacy_compatibility_matrix"),
        "risk_profile.legacy_compatibility_matrix",
        errors,
        required=bool(risk.get("legacy_compatibility")),
        text_fields=("consumer", "entrypoint"),
        list_fields=("variants",),
        minimum_list_sizes={"variants": 1},
    )
    documentation_claim_inventory = _object_inventory(
        risk.get("documentation_claim_inventory"),
        "risk_profile.documentation_claim_inventory",
        errors,
        required=bool(risk.get("documentation_claims")),
        text_fields=("claim", "document_path"),
        list_fields=("runtime_evidence_paths", "test_paths"),
        minimum_list_sizes={"runtime_evidence_paths": 1, "test_paths": 1},
    )

    if risk.get("visual"):
        validate_visual_contract(risk.get("visual_contract"), errors)
    elif risk.get("visual_contract") not in (None, {}, {
        "routes": [], "validator_paths": [], "workflow_paths": [], "documentation_paths": [],
        "controls": [], "controls_rationale": "", "dynamic_surfaces": [], "dynamic_surfaces_rationale": "",
        "table_surfaces": [], "table_surfaces_rationale": "", "dialog_surfaces": [], "dialog_surfaces_rationale": "",
    }):
        # Non-visual changes may retain an empty template, but not a populated hidden contract.
        contract = risk.get("visual_contract")
        if isinstance(contract, dict) and any(contract.get(key) for key in ("routes", "controls", "dynamic_surfaces", "table_surfaces", "dialog_surfaces")):
            errors.append("visual_contract is populated while visual=false")

    # Silence unused variable warning while preserving strict validation side effect.
    _ = (
        dependencies, public_boundaries, business_operations,
        structural_invariants, freshness_sources, stateful_ui_transitions,
        execution_state_boundaries, control_propagation_paths, capability_operation_mappings,
        request_translation_mappings, legacy_compatibility_matrix, documentation_claim_inventory,
    )
    return risk


def required_artifact_kinds(risk: dict[str, Any]) -> set[str]:
    """Return only artifacts explicitly promised for remote publication.

    Local attested evidence is canonical for visual, persistence, migration and
    documentation gates. Requiring remote artifacts for those categories would
    pressure the controller to create or modify GitHub Actions workflows merely
    to satisfy its own gate. An audit manifest remains required only when the
    risk profile explicitly declares that it was published.
    """
    return {"audit-manifest"} if risk.get("audit_packet_published") else set()
