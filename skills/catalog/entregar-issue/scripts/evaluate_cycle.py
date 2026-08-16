#!/usr/bin/env python3
"""Evaluate an Issue Loop Engineer v5 cycle from evidence-backed artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VALID_VALIDITIES = {"absent", "controller-adversarial", "isolated-within-run", "independent"}
VALID_VERDICTS = {"not-run", "Aprovado", "Aprovado com ressalvas", "Reprovado"}
VALID_CAUSES = {
    "implementation-defect",
    "specification-gap",
    "skill-defect",
    "documentation-defect",
    "environment-gap",
    "audit-defect",
    "regression-defect",
}
FINAL_DECISIONS = {"APPROVED", "INTERNALLY_APPROVED", "LIMIT_REACHED", "BLOCKED"}
MAX_CYCLES = 10
IDENTITY_FIELDS = (
    "repository",
    "issue",
    "pull_request",
    "branch",
    "head_sha",
    "base_sha",
    "merge_preview_sha",
    "issue_snapshot_sha256",
    "diff_sha256",
    "skills_sha256",
)
INPUT_PARSER_PATH = re.compile(r"(^|/)[^/]*(parser|decoder|deserializer|lexer|tokenizer)[^/]*\.[^/]+$", re.IGNORECASE)
HIERARCHICAL_INPUT_PARSER_PATH = re.compile(r"(^|/)[^/]*(xml|sgml|ofx|html|yaml|toml)[^/]*(parser|decoder|deserializer|lexer|tokenizer)?[^/]*\.[^/]+$", re.IGNORECASE)
INPUT_PARSER_REQUIRED_DIMENSIONS = {
    "raw-boundary-preservation",
    "validation-order-error-precedence",
    "syntax-mode-invariant-matrix",
}
HIERARCHICAL_INPUT_PARSER_REQUIRED_DIMENSIONS = {
    "scope-membership",
    "inactive-content",
    "cross-scope-context",
}
INPUT_PARSER_CONTROL_IDS = {
    "IP-RAW-001",
    "IP-MODE-001",
    "IP-SCOPE-001",
    "IP-INACTIVE-001",
    "IP-EFFECT-001",
}
INPUT_PARSER_RAW_CASES = {
    "empty",
    "whitespace-only",
    "limit-minus-one",
    "limit-exact",
    "limit-plus-one",
    "valid-plus-external-padding-over-limit",
    "invalid-encoding",
    "bom",
    "truncated",
}
INPUT_PARSER_SCOPE_PLACEMENTS = {
    "direct",
    "generic-container",
    "scalar-container",
}

CORE_ARTIFACTS = {
    "execution-context",
    "specification-snapshot",
    "requirement-closure",
    "risk-profile",
    "documentation-impact",
    "gate-report",
    "source-manifest",
    "requirements-rederivation",
    "coverage-matrix",
    "applicability-ledger",
    "controller-audit-report",
    "cycle-history",
}


def fail(message: str) -> None:
    raise ValueError(message)


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{label} file not found: {path}")
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {label} {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} root must be an object")
    return value


def load_state(path: Path) -> dict[str, Any]:
    return load_json(path, "state")


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def parse_time(value: Any, field: str, *, nullable: bool = False) -> datetime | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.strip():
        fail(f"{field} must be an ISO-8601 string")
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        fail(f"{field} must be an ISO-8601 string")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def validate_identity(identity: Any, field: str) -> None:
    if not isinstance(identity, dict):
        fail(f"{field} must be an object")
    for key in IDENTITY_FIELDS:
        if key not in identity:
            fail(f"{field}.{key} is required")
    if not isinstance(identity["repository"], str) or len(identity["repository"]) < 3:
        fail(f"{field}.repository is invalid")
    if not isinstance(identity["issue"], int) or isinstance(identity["issue"], bool) or identity["issue"] < 1:
        fail(f"{field}.issue is invalid")
    for key in ("head_sha", "base_sha"):
        if not isinstance(identity[key], str) or len(identity[key]) < 7:
            fail(f"{field}.{key} is invalid")
    for key in ("issue_snapshot_sha256", "diff_sha256", "skills_sha256"):
        if not is_sha256(identity[key]):
            fail(f"{field}.{key} must be a lowercase SHA-256")
    parse_time(identity.get("captured_at"), f"{field}.captured_at")


def identity_matches(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(field) == right.get(field) for field in IDENTITY_FIELDS)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_path(state_path: Path, value: str) -> Path:
    result = Path(value)
    if not result.is_absolute():
        result = state_path.parent / result
    return result


def validate_negative_control_shape(control: Any, field: str) -> None:
    if not isinstance(control, dict):
        fail(f"{field} must be an object")
    required = (
        "id", "risk_family", "dimension", "failure_mode",
        "plausible_wrong_implementation", "control_type", "procedure",
        "expected", "observed", "status", "evidence_path",
        "evidence_sha256", "head_sha", "sibling_cases",
    )
    for key in required:
        if key not in control:
            fail(f"{field}.{key} is required")
    for key in (
        "id", "risk_family", "dimension", "failure_mode",
        "plausible_wrong_implementation", "procedure", "expected",
        "observed", "evidence_path", "head_sha",
    ):
        if not isinstance(control.get(key), str) or not control[key].strip():
            fail(f"{field}.{key} must be a non-empty string")
    if control.get("control_type") not in {"test", "gate", "scenario", "procedure"}:
        fail(f"{field}.control_type is invalid")
    if control.get("status") not in {"passed", "failed", "not-run"}:
        fail(f"{field}.status is invalid")
    if not is_sha256(control.get("evidence_sha256")):
        fail(f"{field}.evidence_sha256 must be a lowercase SHA-256")
    siblings = control.get("sibling_cases")
    if not isinstance(siblings, list) or any(not isinstance(item, str) or not item.strip() for item in siblings):
        fail(f"{field}.sibling_cases must be a string array")


def validate_state(state: dict[str, Any]) -> None:
    if state.get("schema_version") != 5:
        fail("schema_version must be 5; migrate older states before evaluation")
    cycle = state.get("cycle")
    if not isinstance(cycle, int) or isinstance(cycle, bool) or not 1 <= cycle <= MAX_CYCLES:
        fail(f"cycle must be an integer from 1 to {MAX_CYCLES}")
    if state.get("single_invocation_mode") is not True:
        fail("single_invocation_mode must be true")
    if state.get("controller_mode") not in {"delivery-single-invocation", "issue-loop-single-invocation"}:
        fail("controller_mode must be delivery-single-invocation or its legacy alias")
    if state.get("execution_mode") not in {"standard", "implement-pendencies"}:
        fail("execution_mode must be standard or implement-pendencies")

    validate_identity(state.get("frozen_identity"), "frozen_identity")
    validate_identity(state.get("current_identity"), "current_identity")

    audit = state.get("audit")
    if not isinstance(audit, dict):
        fail("audit must be an object")
    if audit.get("validity") not in VALID_VALIDITIES:
        fail("audit.validity is invalid")
    if audit.get("verdict") not in VALID_VERDICTS:
        fail("audit.verdict is invalid")
    if audit.get("identity") is not None:
        validate_identity(audit["identity"], "audit.identity")
    for key in (
        "read_only",
        "requirements_rederived",
        "modifications_detected",
        "isolation_proven",
        "external_context_proven",
        "signature_required",
        "implementation_conclusions_included",
        "implementation_narrative_included",
    ):
        if not isinstance(audit.get(key), bool):
            fail(f"audit.{key} must be a boolean")
    if audit.get("signature_valid") is not None and not isinstance(audit.get("signature_valid"), bool):
        fail("audit.signature_valid must be boolean or null")
    for key in (
        "neutral_packet_sha256",
        "report_sha256",
        "requirements_rederivation_sha256",
        "coverage_matrix_sha256",
        "source_manifest_sha256",
    ):
        if audit.get(key) is not None and not is_sha256(audit.get(key)):
            fail(f"audit.{key} must be a lowercase SHA-256 or null")
    parse_time(audit.get("started_at"), "audit.started_at", nullable=True)
    parse_time(audit.get("finished_at"), "audit.finished_at", nullable=True)

    for flag in ("requirements_inventory_complete", "gate_inventory_complete"):
        if not isinstance(state.get(flag), bool):
            fail(f"{flag} must be a boolean")

    list_fields = (
        "requirements",
        "gates",
        "findings",
        "regressions",
        "limitations",
        "skill_changes",
        "operational_amendments",
        "artifacts",
        "risk_families",
        "subskill_results",
        "changed_files",
        "audit_escapes",
        "adversarial_controls",
    )
    for name in list_fields:
        if not isinstance(state.get(name), list):
            fail(f"{name} must be an array")

    requirement_ids: set[str] = set()
    for index, requirement in enumerate(state["requirements"]):
        if not isinstance(requirement, dict):
            fail(f"requirements[{index}] must be an object")
        for key in ("id", "origin", "statement", "status", "evidence", "negative_controls", "negative_control_evidence", "regression_evidence"):
            if key not in requirement:
                fail(f"requirements[{index}].{key} is required")
        req_id = requirement.get("id")
        if not isinstance(req_id, str) or not req_id:
            fail(f"requirements[{index}].id is invalid")
        if req_id in requirement_ids:
            fail(f"requirements[{index}].id is duplicated")
        requirement_ids.add(req_id)
        if not isinstance(requirement.get("origin"), str) or not requirement["origin"].strip():
            fail(f"requirements[{index}].origin is required")
        if not isinstance(requirement.get("statement"), str) or len(requirement["statement"].strip()) < 5:
            fail(f"requirements[{index}].statement is required")
        if requirement.get("status") not in {
            "Implementado", "Parcial", "Nao implementado", "Incorreto", "Nao verificavel", "Fora do escopo"
        }:
            fail(f"requirements[{index}].status is invalid")
        for key in ("evidence", "negative_controls", "regression_evidence"):
            values = requirement.get(key)
            if not isinstance(values, list) or any(not isinstance(item, str) or not item.strip() for item in values):
                fail(f"requirements[{index}].{key} must be a string array")
        controls = requirement.get("negative_control_evidence")
        if not isinstance(controls, list):
            fail(f"requirements[{index}].negative_control_evidence must be an array")
        control_ids: set[str] = set()
        for control_index, control in enumerate(controls):
            validate_negative_control_shape(control, f"requirements[{index}].negative_control_evidence[{control_index}]")
            control_id = control["id"]
            if control_id in control_ids:
                fail(f"requirements[{index}].negative_control_evidence id {control_id} is duplicated")
            control_ids.add(control_id)

    gate_names: set[str] = set()
    for index, gate in enumerate(state["gates"]):
        if not isinstance(gate, dict):
            fail(f"gates[{index}] must be an object")
        name = gate.get("name")
        if not isinstance(name, str) or not name:
            fail(f"gates[{index}].name is required")
        if name in gate_names:
            fail(f"gates[{index}].name is duplicated")
        gate_names.add(name)
        if not isinstance(gate.get("required"), bool):
            fail(f"gates[{index}].required must be a boolean")
        if gate.get("status") not in {"passed", "failed", "not-run", "not-applicable"}:
            fail(f"gates[{index}].status is invalid")

    finding_ids: set[str] = set()
    for index, finding in enumerate(state["findings"]):
        if not isinstance(finding, dict):
            fail(f"findings[{index}] must be an object")
        finding_id = finding.get("id")
        if not isinstance(finding_id, str) or not finding_id:
            fail(f"findings[{index}].id is required")
        if finding_id in finding_ids:
            fail(f"findings[{index}].id is duplicated")
        finding_ids.add(finding_id)
        if finding.get("status") not in {"open", "closed"}:
            fail(f"findings[{index}].status is invalid")
        if finding.get("disposition") not in {"blocking", "recommendation"}:
            fail(f"findings[{index}].disposition is invalid")
        if not isinstance(finding.get("fingerprint"), str) or not finding["fingerprint"]:
            fail(f"findings[{index}].fingerprint is required")
        if finding.get("cause") is not None and finding.get("cause") not in VALID_CAUSES:
            fail(f"findings[{index}].cause is invalid")

    artifact_names: set[str] = set()
    for index, artifact in enumerate(state["artifacts"]):
        if not isinstance(artifact, dict):
            fail(f"artifacts[{index}] must be an object")
        for key in ("name", "required", "status", "path", "sha256", "head_sha"):
            if key not in artifact:
                fail(f"artifacts[{index}].{key} is required")
        name = artifact.get("name")
        if not isinstance(name, str) or not name:
            fail(f"artifacts[{index}].name is invalid")
        if name in artifact_names:
            fail(f"artifacts[{index}].name is duplicated")
        artifact_names.add(name)
        if not isinstance(artifact.get("required"), bool):
            fail(f"artifacts[{index}].required must be a boolean")
        if artifact.get("status") not in {"present", "missing", "not-applicable"}:
            fail(f"artifacts[{index}].status is invalid")

    family_names: set[str] = set()
    for index, family in enumerate(state["risk_families"]):
        if not isinstance(family, dict):
            fail(f"risk_families[{index}] must be an object")
        for key in ("name", "applicable", "basis", "required_gates", "required_subskills"):
            if key not in family:
                fail(f"risk_families[{index}].{key} is required")
        name = family.get("name")
        if not isinstance(name, str) or not name:
            fail(f"risk_families[{index}].name is invalid")
        if name in family_names:
            fail(f"risk_families[{index}].name is duplicated")
        family_names.add(name)
        if not isinstance(family.get("applicable"), bool):
            fail(f"risk_families[{index}].applicable must be a boolean")
        if not isinstance(family.get("basis"), str) or not family["basis"].strip():
            fail(f"risk_families[{index}].basis is required")
        for key in ("required_gates", "required_subskills"):
            values = family.get(key)
            if not isinstance(values, list) or any(not isinstance(item, str) or not item for item in values):
                fail(f"risk_families[{index}].{key} must be a string array")

    changed_paths: set[str] = set()
    for index, item in enumerate(state["changed_files"]):
        if not isinstance(item, dict):
            fail(f"changed_files[{index}] must be an object")
        path = item.get("path")
        families = item.get("families")
        if not isinstance(path, str) or not path:
            fail(f"changed_files[{index}].path is required")
        if path in changed_paths:
            fail(f"changed_files[{index}].path is duplicated")
        changed_paths.add(path)
        if not isinstance(families, list) or not families or any(not isinstance(value, str) or not value for value in families):
            fail(f"changed_files[{index}].families must be a non-empty string array")

    prior = state.get("prior_internal_approval")
    if prior is not None:
        if not isinstance(prior, dict):
            fail("prior_internal_approval must be an object or null")
        for key in ("head_sha", "report_sha256", "assurance_level", "approved_at"):
            if key not in prior:
                fail(f"prior_internal_approval.{key} is required")
        if not is_sha256(prior.get("report_sha256")):
            fail("prior_internal_approval.report_sha256 is invalid")
        if prior.get("assurance_level") not in {"controller-adversarial", "isolated-within-run"}:
            fail("prior_internal_approval.assurance_level is invalid")
        parse_time(prior.get("approved_at"), "prior_internal_approval.approved_at")

    escape_ids: set[str] = set()
    for index, escape in enumerate(state.get("audit_escapes", [])):
        if not isinstance(escape, dict):
            fail(f"audit_escapes[{index}] must be an object")
        for key in ("id", "finding_id", "fingerprint", "affected_head_sha", "prior_internal_report_sha256", "independent_report_sha256", "detected_at", "root_cause_completed", "skill_improvement_required", "skill_improvement_completed", "reusable_control_id"):
            if key not in escape:
                fail(f"audit_escapes[{index}].{key} is required")
        if escape["id"] in escape_ids:
            fail(f"audit_escapes[{index}].id is duplicated")
        escape_ids.add(escape["id"])
        if escape["finding_id"] not in finding_ids:
            fail(f"audit_escapes[{index}].finding_id is unknown")
        if not is_sha256(escape["prior_internal_report_sha256"]) or not is_sha256(escape["independent_report_sha256"]):
            fail(f"audit_escapes[{index}] report hashes are invalid")
        if escape["skill_improvement_required"] is not True:
            fail(f"audit_escapes[{index}].skill_improvement_required must be true")
        parse_time(escape["detected_at"], f"audit_escapes[{index}].detected_at")

    control_ids: set[str] = set()
    for index, control in enumerate(state.get("adversarial_controls", [])):
        if not isinstance(control, dict):
            fail(f"adversarial_controls[{index}] must be an object")
        for key in ("id", "source_escape_id", "fingerprint", "risk_family", "description", "control_type", "path", "sha256", "active"):
            if key not in control:
                fail(f"adversarial_controls[{index}].{key} is required")
        if control["id"] in control_ids:
            fail(f"adversarial_controls[{index}].id is duplicated")
        control_ids.add(control["id"])
        if control["source_escape_id"] not in escape_ids:
            fail(f"adversarial_controls[{index}].source_escape_id is unknown")
        if control["control_type"] not in {"test", "gate", "checklist", "scenario"}:
            fail(f"adversarial_controls[{index}].control_type is invalid")
        if not is_sha256(control["sha256"]) or control["active"] is not True:
            fail(f"adversarial_controls[{index}] hash or active flag is invalid")

    review = state.get("learning_review")
    if not isinstance(review, dict):
        fail("learning_review must be an object")
    for key in ("required", "completed"):
        if not isinstance(review.get(key), bool):
            fail(f"learning_review.{key} must be a boolean")
    if not isinstance(review.get("reviewed_finding_ids"), list) or not isinstance(review.get("items"), list):
        fail("learning_review reviewed_finding_ids and items must be arrays")

    blocked = state.get("blocked")
    if not isinstance(blocked, dict):
        fail("blocked must be an object")
    for key in ("active", "external", "alternatives_exhausted"):
        if not isinstance(blocked.get(key), bool):
            fail(f"blocked.{key} must be a boolean")


def validate_artifacts(state_path: Path, state: dict[str, Any]) -> tuple[bool, list[str], dict[str, Path]]:
    failures: list[str] = []
    resolved_by_name: dict[str, Path] = {}
    by_name = {item["name"]: item for item in state["artifacts"]}
    expected = set(CORE_ARTIFACTS)
    parser_family = next(
        (item for item in state["risk_families"] if item.get("name") == "input-parser"),
        None,
    )
    if parser_family is not None and parser_family.get("applicable") is True:
        expected.add("input-parser-attack-matrix")
    if state["frozen_identity"].get("pull_request") is not None:
        expected.add("remote-gate")
    if state.get("audit_escapes"):
        expected.update({"audit-escape-ledger", "adversarial-controls"})
    missing_declarations = expected - set(by_name)
    for name in sorted(missing_declarations):
        failures.append(f"artifact {name} is not declared")
    frozen_head = state["frozen_identity"]["head_sha"]
    for name, artifact in by_name.items():
        must_exist = artifact.get("required") is True or name in expected
        if not must_exist:
            continue
        if artifact.get("status") != "present":
            failures.append(f"artifact {name} is not present")
            continue
        path = artifact.get("path")
        digest = artifact.get("sha256")
        if not isinstance(path, str) or not path:
            failures.append(f"artifact {name} path is missing")
            continue
        if not is_sha256(digest):
            failures.append(f"artifact {name} sha256 is invalid")
            continue
        if artifact.get("head_sha") != frozen_head:
            failures.append(f"artifact {name} targets a different head SHA")
        resolved = resolve_path(state_path, path)
        resolved_by_name[name] = resolved
        if not resolved.is_file():
            failures.append(f"artifact {name} file does not exist")
            continue
        if file_sha256(resolved) != digest:
            failures.append(f"artifact {name} hash mismatch")
    return not failures, failures, resolved_by_name


def validate_semantic_artifacts(
    state_path: Path,
    state: dict[str, Any],
    artifact_paths: dict[str, Path],
) -> tuple[bool, list[str]]:
    failures: list[str] = []
    artifacts = {item["name"]: item for item in state["artifacts"]}

    def read(name: str) -> dict[str, Any] | None:
        path = artifact_paths.get(name)
        if path is None or not path.is_file():
            return None
        return load_json(path, name)

    source_manifest = read("source-manifest")
    source_ids: set[str] = set()
    if source_manifest is not None:
        if source_manifest.get("schema_version") != 1 or source_manifest.get("complete") is not True:
            failures.append("source-manifest must be schema v1 and complete")
        sources = source_manifest.get("sources")
        if not isinstance(sources, list) or not sources:
            failures.append("source-manifest must contain at least one source")
        else:
            for index, source in enumerate(sources):
                if not isinstance(source, dict):
                    failures.append(f"source-manifest source {index} is invalid")
                    continue
                source_id = source.get("id")
                if not isinstance(source_id, str) or not source_id:
                    failures.append(f"source-manifest source {index} has no id")
                    continue
                if source_id in source_ids:
                    failures.append(f"source-manifest source id {source_id} is duplicated")
                source_ids.add(source_id)
                if not isinstance(source.get("kind"), str) or not source.get("locator") or not is_sha256(source.get("sha256")):
                    failures.append(f"source-manifest source {source_id} lacks kind, locator or hash")
        discovery = source_manifest.get("discovery")
        if not isinstance(discovery, dict):
            failures.append("source-manifest requires reproducible discovery metadata")
        else:
            for key in ("commands", "roots", "discovered_paths", "declared_paths", "omitted_sources", "stale_claim_queries", "unresolved_stale_claims"):
                if not isinstance(discovery.get(key), list):
                    failures.append(f"source-manifest discovery.{key} must be an array")
            if not isinstance(discovery.get("state_transition"), bool):
                failures.append("source-manifest discovery.state_transition must be boolean")
            for key in ("commands", "roots", "discovered_paths", "declared_paths", "stale_claim_queries", "unresolved_stale_claims"):
                values = discovery.get(key, [])
                if isinstance(values, list) and any(not isinstance(item, str) or not item.strip() for item in values):
                    failures.append(f"source-manifest discovery.{key} must contain non-empty strings")
            if isinstance(discovery.get("commands"), list) and not discovery["commands"]:
                failures.append("source-manifest discovery.commands must not be empty")
            if isinstance(discovery.get("roots"), list) and not discovery["roots"]:
                failures.append("source-manifest discovery.roots must not be empty")
            if isinstance(discovery.get("discovered_paths"), list) and not discovery["discovered_paths"]:
                failures.append("source-manifest discovery.discovered_paths must not be empty")
            omitted_paths: set[str] = set()
            omitted = discovery.get("omitted_sources", [])
            if isinstance(omitted, list):
                for index, item in enumerate(omitted):
                    if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not item["path"].strip() or not isinstance(item.get("reason"), str) or not item["reason"].strip():
                        failures.append(f"source-manifest discovery.omitted_sources[{index}] requires path and reason")
                    else:
                        omitted_paths.add(item["path"] )
            discovered_paths = set(discovery.get("discovered_paths", [])) if isinstance(discovery.get("discovered_paths"), list) else set()
            declared_paths = set(discovery.get("declared_paths", [])) if isinstance(discovery.get("declared_paths"), list) else set()
            if discovered_paths and discovered_paths != declared_paths | omitted_paths:
                failures.append("source-manifest discovered paths must equal declared paths plus justified omissions")
            if discovery.get("state_transition") is True and not discovery.get("stale_claim_queries"):
                failures.append("source-manifest state transition requires stale-claim queries")
            if discovery.get("unresolved_stale_claims"):
                failures.append("source-manifest contains unresolved stale documentation claims")

        for requirement in state["requirements"]:
            if requirement["origin"] not in source_ids:
                failures.append(f"{requirement['id']}: origin {requirement['origin']} is absent from source-manifest")

    rederivation = read("requirements-rederivation")
    if rederivation is not None:
        if rederivation.get("schema_version") != 1 or rederivation.get("complete") is not True:
            failures.append("requirements-rederivation must be schema v1 and complete")
        source_hash = artifacts.get("source-manifest", {}).get("sha256")
        if rederivation.get("source_manifest_sha256") != source_hash:
            failures.append("requirements-rederivation references a different source-manifest")
        actual = {
            item.get("id"): (item.get("origin"), item.get("statement"))
            for item in rederivation.get("requirements", []) if isinstance(item, dict)
        }
        expected = {item["id"]: (item["origin"], item["statement"]) for item in state["requirements"]}
        if actual != expected:
            failures.append("requirements-rederivation differs from the state requirement inventory")

    coverage = read("coverage-matrix")
    if coverage is not None:
        if coverage.get("schema_version") != 1 or coverage.get("complete") is not True:
            failures.append("coverage-matrix must be schema v1 and complete")
        rows = {item.get("requirement_id"): item for item in coverage.get("requirements", []) if isinstance(item, dict)}
        if set(rows) != {item["id"] for item in state["requirements"]}:
            failures.append("coverage-matrix does not cover the exact requirement inventory")
        for requirement in state["requirements"]:
            row = rows.get(requirement["id"])
            if row is None:
                continue
            if row.get("positive_evidence") != requirement["evidence"]:
                failures.append(f"{requirement['id']}: positive evidence differs from coverage-matrix")
            if row.get("negative_controls") != requirement["negative_controls"]:
                failures.append(f"{requirement['id']}: negative controls differ from coverage-matrix")
            if row.get("negative_control_evidence") != requirement["negative_control_evidence"]:
                failures.append(f"{requirement['id']}: negative control evidence differs from coverage-matrix")
            if row.get("regression_evidence") != requirement["regression_evidence"]:
                failures.append(f"{requirement['id']}: regression evidence differs from coverage-matrix")

    applicability = read("applicability-ledger")
    if applicability is not None:
        if applicability.get("schema_version") != 1 or applicability.get("complete") is not True:
            failures.append("applicability-ledger must be schema v1 and complete")
        changed = {item.get("path"): item.get("families") for item in applicability.get("changed_files", []) if isinstance(item, dict)}
        expected_changed = {item["path"]: item["families"] for item in state["changed_files"]}
        if changed != expected_changed:
            failures.append("applicability-ledger changed_files differs from state")
        families = {
            item.get("name"): (
                item.get("applicable"), item.get("required_gates"), item.get("required_subskills")
            )
            for item in applicability.get("risk_families", []) if isinstance(item, dict)
        }
        expected_families = {
            item["name"]: (item["applicable"], item["required_gates"], item["required_subskills"])
            for item in state["risk_families"]
        }
        if families != expected_families:
            failures.append("applicability-ledger risk families differ from state")

    gate_report = read("gate-report")
    if gate_report is not None:
        if gate_report.get("schema_version") != 1 or gate_report.get("complete") is not True:
            failures.append("gate-report must be schema v1 and complete")
        report_gates = {
            item.get("name"): (item.get("status"), item.get("attestation_sha256"))
            for item in gate_report.get("gates", []) if isinstance(item, dict)
        }
        expected_gates = {
            item["name"]: (item["status"], item.get("attestation_sha256"))
            for item in state["gates"]
        }
        if report_gates != expected_gates:
            failures.append("gate-report differs from state gates")

    history = read("cycle-history")
    if history is not None:
        if history.get("schema_version") != 1 or history.get("append_only") is not True:
            failures.append("cycle-history must be schema v1 and append_only")
        cycles = history.get("cycles")
        if not isinstance(cycles, list) or not cycles:
            failures.append("cycle-history has no cycles")
        else:
            numbers = [item.get("cycle") for item in cycles if isinstance(item, dict)]
            if numbers != sorted(numbers) or len(numbers) != len(set(numbers)):
                failures.append("cycle-history cycles are not unique and ordered")
            if state["cycle"] not in numbers:
                failures.append("current cycle is absent from cycle-history")
            fingerprint_counts: dict[str, int] = {}
            for item in cycles:
                if not isinstance(item, dict):
                    continue
                for fingerprint in item.get("finding_fingerprints", []):
                    if isinstance(fingerprint, str):
                        fingerprint_counts[fingerprint] = fingerprint_counts.get(fingerprint, 0) + 1
            for finding in state["findings"]:
                expected_count = fingerprint_counts.get(finding["fingerprint"], 0)
                if expected_count != finding.get("occurrence_count"):
                    failures.append(
                        f"{finding['id']}: occurrence_count must be derived from cycle-history "
                        f"({expected_count}, not {finding.get('occurrence_count')})"
                    )

    audit = state["audit"]
    artifact_to_audit = {
        "controller-audit-report": ("report_path", "report_sha256"),
        "requirements-rederivation": ("requirements_rederivation_path", "requirements_rederivation_sha256"),
        "coverage-matrix": ("coverage_matrix_path", "coverage_matrix_sha256"),
        "source-manifest": ("source_manifest_path", "source_manifest_sha256"),
    }
    for name, (path_key, hash_key) in artifact_to_audit.items():
        artifact = artifacts.get(name)
        if artifact is None:
            continue
        if audit.get(path_key) != artifact.get("path") or audit.get(hash_key) != artifact.get("sha256"):
            failures.append(f"audit {name} path/hash differs from artifact manifest")

    if state.get("audit_escapes"):
        escape_ledger = read("audit-escape-ledger")
        if escape_ledger is not None:
            if escape_ledger.get("schema_version") != 1 or escape_ledger.get("append_only") is not True:
                failures.append("audit-escape-ledger must be schema v1 and append_only")
            ledger_ids = {item.get("id") for item in escape_ledger.get("escapes", []) if isinstance(item, dict)}
            expected_ids = {item.get("id") for item in state.get("audit_escapes", [])}
            if ledger_ids != expected_ids:
                failures.append("audit-escape-ledger differs from state")
        controls_ledger = read("adversarial-controls")
        if controls_ledger is not None:
            if controls_ledger.get("schema_version") != 1 or controls_ledger.get("append_only") is not True:
                failures.append("adversarial-controls must be schema v1 and append_only")
            ledger_ids = {item.get("id") for item in controls_ledger.get("controls", []) if isinstance(item, dict)}
            expected_ids = {item.get("id") for item in state.get("adversarial_controls", [])}
            if ledger_ids != expected_ids:
                failures.append("adversarial-controls ledger differs from state")

    return not failures, failures


def validate_gate_attestation(state_path: Path, state: dict[str, Any], gate: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    name = gate["name"]
    for key in (
        "command", "cwd", "exit_code", "started_at", "finished_at", "attestation_path", "attestation_sha256",
        "stdout_sha256", "stderr_sha256", "head_sha"
    ):
        if gate.get(key) in (None, ""):
            failures.append(f"{name}: {key} is missing")
    if failures:
        return failures
    if gate.get("exit_code") != 0:
        failures.append(f"{name}: exit_code is not zero")
    if gate.get("head_sha") != state["frozen_identity"]["head_sha"]:
        failures.append(f"{name}: head SHA differs from frozen identity")
    for key in ("attestation_sha256", "stdout_sha256", "stderr_sha256"):
        if not is_sha256(gate.get(key)):
            failures.append(f"{name}: {key} is invalid")
    start = parse_time(gate.get("started_at"), f"gate {name}.started_at")
    finish = parse_time(gate.get("finished_at"), f"gate {name}.finished_at")
    if start and finish and finish < start:
        failures.append(f"{name}: finished_at precedes started_at")
    if failures:
        return failures
    path = resolve_path(state_path, gate["attestation_path"])
    if not path.is_file():
        return [f"{name}: attestation file does not exist"]
    if file_sha256(path) != gate["attestation_sha256"]:
        return [f"{name}: attestation hash mismatch"]
    attestation = load_json(path, f"gate attestation {name}")
    expected = {
        "schema_version": 1,
        "name": name,
        "command": gate["command"],
        "cwd": gate["cwd"],
        "exit_code": gate["exit_code"],
        "started_at": gate["started_at"],
        "finished_at": gate["finished_at"],
        "head_sha": gate["head_sha"],
        "stdout_sha256": gate["stdout_sha256"],
        "stderr_sha256": gate["stderr_sha256"],
    }
    for key, value in expected.items():
        if attestation.get(key) != value:
            failures.append(f"{name}: attestation {key} does not match state")
    return failures


def validate_gates(state_path: Path, state: dict[str, Any]) -> tuple[bool, list[str]]:
    failures: list[str] = []
    required = [gate for gate in state["gates"] if gate.get("required")]
    if not state["gate_inventory_complete"]:
        failures.append("gate inventory is not complete")
    if not required:
        failures.append("no required gate was declared")
    for gate in required:
        name = gate["name"]
        if gate.get("status") != "passed":
            failures.append(f"{name}: status is not passed")
            continue
        failures.extend(validate_gate_attestation(state_path, state, gate))
    return not failures, failures


def validate_requirements(state_path: Path, state: dict[str, Any]) -> tuple[bool, list[str]]:
    failures: list[str] = []
    if not state["requirements_inventory_complete"]:
        failures.append("requirements inventory is not complete")
    if not state["requirements"]:
        failures.append("requirements inventory is empty")
    frozen_head = state["frozen_identity"]["head_sha"]
    for requirement in state["requirements"]:
        req_id = requirement["id"]
        status = requirement["status"]
        if status not in {"Implementado", "Fora do escopo"}:
            failures.append(f"{req_id}: unresolved status {status}")
        if status == "Implementado":
            if not requirement["evidence"]:
                failures.append(f"{req_id}: implementation evidence is missing")
            control_ids = requirement["negative_controls"]
            controls = requirement["negative_control_evidence"]
            if not control_ids:
                failures.append(f"{req_id}: negative control is missing")
            evidence_by_id = {item["id"]: item for item in controls}
            if set(evidence_by_id) != set(control_ids):
                failures.append(f"{req_id}: negative control ids and evidence do not match exactly")
            for control_id in control_ids:
                control = evidence_by_id.get(control_id)
                if control is None:
                    continue
                if control["status"] != "passed":
                    failures.append(f"{req_id}/{control_id}: negative control did not pass")
                if control["head_sha"] != frozen_head:
                    failures.append(f"{req_id}/{control_id}: negative control targets a different head SHA")
                evidence = resolve_path(state_path, control["evidence_path"])
                if not evidence.is_file():
                    failures.append(f"{req_id}/{control_id}: negative control evidence file does not exist")
                elif file_sha256(evidence) != control["evidence_sha256"]:
                    failures.append(f"{req_id}/{control_id}: negative control evidence hash mismatch")
            if not requirement["regression_evidence"]:
                failures.append(f"{req_id}: regression evidence is missing")
        if status == "Fora do escopo" and not requirement.get("scope_basis"):
            failures.append(f"{req_id}: canonical scope basis is missing")
    return not failures, failures


def _non_empty_unique_strings(value: Any, field: str, failures: list[str]) -> set[str]:
    if not isinstance(value, list) or not value:
        failures.append(f"{field} must be a non-empty string array")
        return set()
    normalized: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            failures.append(f"{field}[{index}] must be a non-empty string")
            continue
        normalized.append(item.strip())
    if len(normalized) != len(set(normalized)):
        failures.append(f"{field} contains duplicate values")
    return set(normalized)


def validate_input_parser_attack_matrix(
    state_path: Path,
    state: dict[str, Any],
    *,
    hierarchical: bool,
) -> list[str]:
    failures: list[str] = []
    artifact = next(
        (item for item in state["artifacts"] if item.get("name") == "input-parser-attack-matrix"),
        None,
    )
    if artifact is None:
        return ["artifact input-parser-attack-matrix is not declared"]
    if artifact.get("status") != "present":
        return ["artifact input-parser-attack-matrix is not present"]
    path_value = artifact.get("path")
    if not isinstance(path_value, str) or not path_value:
        return ["input-parser-attack-matrix path is missing"]
    path = resolve_path(state_path, path_value)
    if not path.is_file():
        return ["input-parser-attack-matrix file does not exist"]

    matrix = load_json(path, "input-parser-attack-matrix")
    if matrix.get("schema_version") != 1:
        failures.append("input-parser-attack-matrix must use schema_version 1")
    frozen_head = state["frozen_identity"]["head_sha"]
    if matrix.get("head_sha") != frozen_head:
        failures.append("input-parser-attack-matrix targets a different head SHA")

    modes = _non_empty_unique_strings(
        matrix.get("accepted_modes"),
        "input-parser-attack-matrix.accepted_modes",
        failures,
    )
    consumed_fields = _non_empty_unique_strings(
        matrix.get("consumed_fields"),
        "input-parser-attack-matrix.consumed_fields",
        failures,
    )
    placements = _non_empty_unique_strings(
        matrix.get("field_scope_placements"),
        "input-parser-attack-matrix.field_scope_placements",
        failures,
    )
    raw_cases = _non_empty_unique_strings(
        matrix.get("raw_boundary_cases"),
        "input-parser-attack-matrix.raw_boundary_cases",
        failures,
    )
    _non_empty_unique_strings(
        matrix.get("error_precedence_cases"),
        "input-parser-attack-matrix.error_precedence_cases",
        failures,
    )
    control_ids = _non_empty_unique_strings(
        matrix.get("control_ids"),
        "input-parser-attack-matrix.control_ids",
        failures,
    )

    missing_raw = sorted(INPUT_PARSER_RAW_CASES - raw_cases)
    if missing_raw:
        failures.append(
            "input-parser-attack-matrix misses mandatory raw boundary cases: "
            f"{missing_raw}"
        )
    missing_controls = sorted(INPUT_PARSER_CONTROL_IDS - control_ids)
    if missing_controls:
        failures.append(
            "input-parser-attack-matrix misses stable parser controls: "
            f"{missing_controls}"
        )
    if hierarchical:
        missing_placements = sorted(INPUT_PARSER_SCOPE_PLACEMENTS - placements)
        if missing_placements:
            failures.append(
                "hierarchical input-parser attack matrix misses scope placements: "
                f"{missing_placements}"
            )

    rows = matrix.get("mode_field_scope_matrix")
    if not isinstance(rows, list) or not rows:
        failures.append("input-parser-attack-matrix.mode_field_scope_matrix must be a non-empty array")
        return failures

    observed: dict[tuple[str, str, str], dict[str, Any]] = {}
    for index, row in enumerate(rows):
        field = f"input-parser-attack-matrix.mode_field_scope_matrix[{index}]"
        if not isinstance(row, dict):
            failures.append(f"{field} must be an object")
            continue
        mode = row.get("mode")
        consumed = row.get("field")
        placement = row.get("placement")
        if not all(isinstance(value, str) and value.strip() for value in (mode, consumed, placement)):
            failures.append(f"{field} requires non-empty mode, field and placement")
            continue
        key = (mode.strip(), consumed.strip(), placement.strip())
        if key in observed:
            failures.append(f"input-parser-attack-matrix duplicates matrix cell {key}")
            continue
        observed[key] = row
        if not isinstance(row.get("required"), bool):
            failures.append(f"{field}.required must be a boolean")
            continue
        evidence_ids = row.get("evidence_ids")
        if row["required"] is True:
            if not isinstance(evidence_ids, list) or not evidence_ids or any(
                not isinstance(item, str) or not item.strip() for item in evidence_ids
            ):
                failures.append(f"{field}.evidence_ids must be non-empty when required=true")
        else:
            rationale = row.get("rationale")
            if not isinstance(rationale, str) or not rationale.strip():
                failures.append(f"{field}.rationale is required when required=false")

    expected_cells = {
        (mode, consumed, placement)
        for mode in modes
        for consumed in consumed_fields
        for placement in placements
    }
    missing_cells = sorted(expected_cells - set(observed))
    extra_cells = sorted(set(observed) - expected_cells)
    if missing_cells:
        failures.append(
            "input-parser-attack-matrix misses mode x consumed-field x placement cells: "
            f"{missing_cells}"
        )
    if extra_cells:
        failures.append(
            "input-parser-attack-matrix contains undeclared matrix cells: "
            f"{extra_cells}"
        )
    return failures


def validate_risk_coverage(state_path: Path, state: dict[str, Any]) -> tuple[bool, list[str]]:
    failures: list[str] = []
    if not state["changed_files"]:
        failures.append("changed_files inventory is empty")
    gates = {gate["name"]: gate for gate in state["gates"]}
    subskills = {item.get("skill"): item for item in state["subskill_results"] if isinstance(item, dict)}
    families = {item["name"]: item for item in state["risk_families"]}
    if "documentation" not in families or families["documentation"].get("applicable") is not True:
        failures.append("documentation risk family must always be applicable")

    parser_paths = [item["path"] for item in state["changed_files"] if INPUT_PARSER_PATH.search(item["path"])]
    parser_family = families.get("input-parser")
    parser_applicable = parser_family is not None and parser_family.get("applicable") is True
    if parser_paths and not parser_applicable:
        failures.append("parser-like changed files require the applicable input-parser risk family")
    if parser_paths:
        for item in state["changed_files"]:
            if item["path"] in parser_paths and "input-parser" not in item["families"]:
                failures.append(f"{item['path']}: parser-like file is not classified as input-parser")

    if parser_applicable:
        input_parser_controls = [
            control
            for requirement in state["requirements"]
            if requirement.get("status") == "Implementado"
            for control in requirement.get("negative_control_evidence", [])
            if control.get("risk_family") == "input-parser" and control.get("status") == "passed"
        ]
        dimensions = {control.get("dimension") for control in input_parser_controls}
        required_dimensions = set(INPUT_PARSER_REQUIRED_DIMENSIONS)
        hierarchical = any(HIERARCHICAL_INPUT_PARSER_PATH.search(path) for path in parser_paths)
        if hierarchical:
            required_dimensions.update(HIERARCHICAL_INPUT_PARSER_REQUIRED_DIMENSIONS)
        missing_dimensions = sorted(required_dimensions - dimensions)
        if missing_dimensions:
            failures.append(
                "input-parser misses mandatory adversarial dimensions: "
                f"{missing_dimensions}"
            )
        executed_control_ids = {control.get("id") for control in input_parser_controls}
        missing_stable_controls = sorted(INPUT_PARSER_CONTROL_IDS - executed_control_ids)
        if missing_stable_controls:
            failures.append(
                "input-parser misses stable executed parser controls: "
                f"{missing_stable_controls}"
            )
        for control in input_parser_controls:
            siblings = {
                item.strip()
                for item in control.get("sibling_cases", [])
                if isinstance(item, str) and item.strip()
            }
            if len(siblings) < 2:
                failures.append(
                    f"{control.get('id')}: input-parser control requires at least two sibling cases"
                )
        failures.extend(
            validate_input_parser_attack_matrix(
                state_path,
                state,
                hierarchical=hierarchical,
            )
        )

    for changed in state["changed_files"]:
        for family_name in changed["families"]:
            family = families.get(family_name)
            if family is None:
                failures.append(f"{changed['path']}: unknown risk family {family_name}")
            elif family.get("applicable") is not True:
                failures.append(f"{changed['path']}: family {family_name} is not marked applicable")
    for family in state["risk_families"]:
        if family.get("applicable") is not True:
            continue
        name = family["name"]
        if not family["required_gates"]:
            failures.append(f"risk family {name} has no required gates")
        for gate_name in family["required_gates"]:
            gate = gates.get(gate_name)
            if gate is None:
                failures.append(f"risk family {name}: required gate {gate_name} is missing")
            elif gate.get("required") is not True:
                failures.append(f"risk family {name}: gate {gate_name} is not marked required")
        for skill in family["required_subskills"]:
            result = subskills.get(skill)
            if result is None:
                failures.append(f"risk family {name}: subskill {skill} result is missing")
                continue
            if result.get("status") not in {"passed", "no-change"}:
                failures.append(f"risk family {name}: subskill {skill} did not pass")
            path = result.get("artifact_path")
            digest = result.get("artifact_sha256")
            if not isinstance(path, str) or not path or not is_sha256(digest):
                failures.append(f"risk family {name}: subskill {skill} evidence is incomplete")
                continue
            resolved = resolve_path(state_path, path)
            if not resolved.is_file():
                failures.append(f"risk family {name}: subskill {skill} evidence file does not exist")
            elif file_sha256(resolved) != digest:
                failures.append(f"risk family {name}: subskill {skill} evidence hash mismatch")
    return not failures, failures


def validate_closed_findings(state_path: Path, state: dict[str, Any]) -> tuple[bool, list[str]]:
    failures: list[str] = []
    for finding in state["findings"]:
        if finding.get("status") != "closed" or finding.get("disposition") != "blocking":
            continue
        finding_id = finding["id"]
        for key in (
            "detected_on_sha", "remediated_on_sha", "remediation_diff_sha256", "regression_test",
            "closure_evidence_path", "closure_evidence_sha256", "verified_cycle"
        ):
            if finding.get(key) in (None, ""):
                failures.append(f"{finding_id}: {key} is required to close a blocking finding")
        if failures and any(item.startswith(f"{finding_id}:") for item in failures):
            continue
        if finding["detected_on_sha"] == finding["remediated_on_sha"]:
            failures.append(f"{finding_id}: remediation must produce a new SHA")
        if finding["remediated_on_sha"] != state["frozen_identity"]["head_sha"]:
            failures.append(f"{finding_id}: remediation SHA is not the frozen SHA")
        if not is_sha256(finding["remediation_diff_sha256"]):
            failures.append(f"{finding_id}: remediation diff hash is invalid")
        if not is_sha256(finding["closure_evidence_sha256"]):
            failures.append(f"{finding_id}: closure evidence hash is invalid")
            continue
        evidence = resolve_path(state_path, finding["closure_evidence_path"])
        if not evidence.is_file():
            failures.append(f"{finding_id}: closure evidence file does not exist")
        elif file_sha256(evidence) != finding["closure_evidence_sha256"]:
            failures.append(f"{finding_id}: closure evidence hash mismatch")
        if not isinstance(finding["verified_cycle"], int) or finding["verified_cycle"] > state["cycle"]:
            failures.append(f"{finding_id}: verified_cycle is invalid")
    return not failures, failures


def validate_learning_review(state_path: Path, state: dict[str, Any]) -> tuple[bool, list[str]]:
    review = state["learning_review"]
    failures: list[str] = []
    findings_exist = bool(state["findings"])
    expected_required = state["execution_mode"] == "implement-pendencies" or findings_exist
    if review.get("required") is not expected_required:
        failures.append("learning_review.required does not match findings/execution mode")
    if not expected_required:
        return not failures, failures
    if review.get("completed") is not True:
        failures.append("learning review is not completed")
    finding_ids = {item["id"] for item in state["findings"]}
    reviewed_ids = set(review.get("reviewed_finding_ids", []))
    if reviewed_ids != finding_ids:
        failures.append("learning review must cover every finding")
    item_ids = {item.get("finding_id") for item in review.get("items", []) if isinstance(item, dict)}
    if item_ids != finding_ids:
        failures.append("learning review items must cover every finding")
    ledger_path = review.get("ledger_path")
    ledger_hash = review.get("ledger_sha256")
    if not isinstance(ledger_path, str) or not ledger_path or not is_sha256(ledger_hash):
        failures.append("learning ledger path/hash is missing")
    else:
        resolved = resolve_path(state_path, ledger_path)
        if not resolved.is_file():
            failures.append("learning ledger file does not exist")
        elif file_sha256(resolved) != ledger_hash:
            failures.append("learning ledger hash mismatch")
    return not failures, failures


def validate_audit_escapes(state_path: Path, state: dict[str, Any], *, require_complete: bool) -> tuple[bool, list[str]]:
    failures: list[str] = []
    controls = {item.get("id"): item for item in state.get("adversarial_controls", []) if isinstance(item, dict)}
    escape_ids: set[str] = set()
    for escape in state.get("audit_escapes", []):
        escape_id = escape.get("id")
        if not isinstance(escape_id, str) or not escape_id:
            failures.append("audit escape id is missing")
            continue
        if escape_id in escape_ids:
            failures.append(f"duplicate audit escape {escape_id}")
        escape_ids.add(escape_id)
        if escape.get("skill_improvement_required") is not True:
            failures.append(f"{escape_id}: skill improvement must be required on first escape")
        if require_complete:
            if escape.get("root_cause_completed") is not True or not escape.get("root_cause"):
                failures.append(f"{escape_id}: root cause is incomplete")
            if escape.get("skill_improvement_completed") is not True:
                failures.append(f"{escape_id}: skill improvement is incomplete")
            control_id = escape.get("reusable_control_id")
            control = controls.get(control_id)
            if not control:
                failures.append(f"{escape_id}: reusable adversarial control is missing")
            else:
                if control.get("source_escape_id") != escape_id or control.get("fingerprint") != escape.get("fingerprint"):
                    failures.append(f"{escape_id}: reusable control linkage is invalid")
                path = resolve_path(state_path, control.get("path", ""))
                if not path.is_file():
                    failures.append(f"{escape_id}: reusable control file does not exist")
                elif not is_sha256(control.get("sha256")) or file_sha256(path) != control.get("sha256"):
                    failures.append(f"{escape_id}: reusable control hash mismatch")
            linked_skill_changes = [
                item for item in state.get("skill_changes", [])
                if isinstance(item, dict) and escape_id in item.get("audit_escape_ids", [])
            ]
            if not linked_skill_changes:
                failures.append(f"{escape_id}: no Skill change is linked to the escape")
            else:
                roles = {item.get("role") for item in linked_skill_changes}
                missing_roles = {"prevention", "detection"} - roles
                if missing_roles:
                    failures.append(
                        f"{escape_id}: Skill changes must cover prevention and detection roles; missing {sorted(missing_roles)}"
                    )
    return not failures, failures


def validate_audit(state_path: Path, state: dict[str, Any], artifact_paths: dict[str, Path]) -> tuple[bool, list[str], str]:
    audit = state["audit"]
    claimed = audit["validity"]
    failures: list[str] = []
    if claimed == "absent" or audit["verdict"] == "not-run":
        return False, ["audit is absent"], "absent"
    freeze_time = parse_time(state["frozen_identity"]["captured_at"], "frozen_identity.captured_at")
    start = parse_time(audit.get("started_at"), "audit.started_at", nullable=True)
    finish = parse_time(audit.get("finished_at"), "audit.finished_at", nullable=True)
    if start is None or finish is None:
        failures.append("audit start and finish timestamps are required")
    else:
        if start < freeze_time:
            failures.append("audit started before freeze")
        if finish < start:
            failures.append("audit finished before it started")
    if audit.get("read_only") is not True:
        failures.append("audit was not read-only")
    if audit.get("requirements_rederived") is not True:
        failures.append("audit did not rederive requirements")
    if not is_sha256(audit.get("neutral_packet_sha256")):
        failures.append("neutral audit packet hash is missing")
    if audit.get("implementation_conclusions_included") is not False:
        failures.append("neutral audit packet includes implementation conclusions")
    if audit.get("implementation_narrative_included") is not False:
        failures.append("neutral audit packet includes implementation narrative")
    if audit.get("modifications_detected") is True:
        failures.append("modifications were detected during audit")
    if audit.get("identity") is None or not identity_matches(state["frozen_identity"], audit["identity"]):
        failures.append("audit identity differs from frozen identity")

    contexts_differ = bool(
        audit.get("implementation_context_id")
        and audit.get("audit_context_id")
        and audit.get("implementation_context_id") != audit.get("audit_context_id")
    )
    effective = "controller-adversarial"
    if claimed == "isolated-within-run" and contexts_differ and audit.get("isolation_proven") is True:
        effective = claimed
    elif claimed == "independent" and contexts_differ and audit.get("external_context_proven") is True:
        effective = claimed

    report_path = artifact_paths.get("controller-audit-report")
    if report_path is None or not report_path.is_file():
        failures.append("controller audit report artifact is missing")
    else:
        report = load_json(report_path, "controller audit report")
        if report.get("schema_version") != 3:
            failures.append("controller audit report schema_version must be 3")
        expected_scope = "independent-release-gate" if effective == "independent" else "internal-only"
        if report.get("approval_scope") != expected_scope:
            failures.append("controller audit report approval_scope differs from effective assurance")
        neutral = report.get("neutral_packet")
        if not isinstance(neutral, dict) or neutral.get("implementation_conclusions_included") is not False or neutral.get("implementation_narrative_included") is not False:
            failures.append("controller audit report neutral packet is contaminated")
        if report.get("verdict") != audit.get("verdict"):
            failures.append("controller audit report verdict differs from state")
        if report.get("mode") != claimed:
            failures.append("controller audit report mode differs from state")
        if report.get("read_only") is not True or report.get("requirements_rederived") is not True:
            failures.append("controller audit report lacks mandatory adversarial properties")
        if report.get("modifications_detected") is not False:
            failures.append("controller audit report records modifications")
        if report.get("prior_internal_approval") != state.get("prior_internal_approval"):
            failures.append("controller audit report prior_internal_approval differs from state")
        expected_escapes = [{
            "finding_id": item.get("finding_id"),
            "fingerprint": item.get("fingerprint"),
            "affected_head_sha": item.get("affected_head_sha"),
            "prior_internal_report_sha256": item.get("prior_internal_report_sha256"),
            "detected_at": item.get("detected_at"),
        } for item in state.get("audit_escapes", [])]
        if report.get("audit_escapes") != expected_escapes:
            failures.append("controller audit report audit_escapes differ from state")
        report_identity = report.get("identity")
        if not isinstance(report_identity, dict) or not identity_matches(state["frozen_identity"], report_identity):
            failures.append("controller audit report identity differs from frozen identity")
        expected_hashes = {
            "source_manifest_sha256": audit.get("source_manifest_sha256"),
            "requirements_rederivation_sha256": audit.get("requirements_rederivation_sha256"),
            "coverage_matrix_sha256": audit.get("coverage_matrix_sha256"),
            "neutral_packet_sha256": audit.get("neutral_packet_sha256"),
        }
        for key, expected in expected_hashes.items():
            if not is_sha256(expected) or report.get(key) != expected:
                failures.append(f"controller audit report {key} is missing or inconsistent")
        if report.get("started_at") != audit.get("started_at") or report.get("finished_at") != audit.get("finished_at"):
            failures.append("controller audit report timestamps differ from state")
        report_requirements = {
            item.get("id"): item for item in report.get("requirements", []) if isinstance(item, dict)
        }
        state_requirements = {item["id"]: item for item in state["requirements"]}
        if set(report_requirements) != set(state_requirements):
            failures.append("controller audit report requirements differ from state inventory")
        else:
            for req_id, expected in state_requirements.items():
                observed = report_requirements[req_id]
                for key in ("origin", "statement", "status", "evidence", "negative_controls", "negative_control_evidence", "regression_evidence"):
                    if observed.get(key) != expected.get(key):
                        failures.append(f"controller audit report {req_id}.{key} differs from state")
        report_findings = {
            item.get("id"): item for item in report.get("findings", []) if isinstance(item, dict)
        }
        state_findings = {item["id"]: item for item in state["findings"]}
        if set(report_findings) != set(state_findings):
            failures.append("controller audit report findings differ from state")
        else:
            for finding_id, expected in state_findings.items():
                observed = report_findings[finding_id]
                for key in ("fingerprint", "severity", "status", "disposition", "requirement_id"):
                    if observed.get(key) != expected.get(key):
                        failures.append(f"controller audit report {finding_id}.{key} differs from state")
                if not observed.get("impact") or not observed.get("evidence"):
                    failures.append(f"controller audit report {finding_id} lacks impact or evidence")
        report_gates = {
            item.get("name"): (item.get("status"), item.get("attestation_sha256"))
            for item in report.get("gates", []) if isinstance(item, dict)
        }
        expected_gates = {
            item["name"]: (item["status"], item.get("attestation_sha256"))
            for item in state["gates"]
        }
        if report_gates != expected_gates:
            failures.append("controller audit report gates differ from state")
        report_limits = {
            (item.get("description"), item.get("material"))
            for item in report.get("limitations", []) if isinstance(item, dict)
        }
        state_limits = {
            (item.get("description"), item.get("material"))
            for item in state["limitations"] if isinstance(item, dict)
        }
        if report_limits != state_limits:
            failures.append("controller audit report limitations differ from state")
    return not failures, failures, effective


def skill_changed_after_audit(state: dict[str, Any]) -> bool:
    finished = parse_time(state["audit"].get("finished_at"), "audit.finished_at", nullable=True)
    if finished is None:
        return False
    for change in state["skill_changes"]:
        changed_at = parse_time(change.get("changed_at"), "skill_changes.changed_at")
        if changed_at and changed_at > finished:
            return True
    return False


def evaluate(state_path: Path, state: dict[str, Any]) -> dict[str, Any]:
    cycle = state["cycle"]
    audit = state["audit"]
    blocked = state["blocked"]

    artifacts_passed, artifact_failures, artifact_paths = validate_artifacts(state_path, state)
    semantic_passed, semantic_failures = validate_semantic_artifacts(state_path, state, artifact_paths)
    gates_passed, gate_failures = validate_gates(state_path, state)
    requirements_passed, requirement_failures = validate_requirements(state_path, state)
    risk_passed, risk_failures = validate_risk_coverage(state_path, state)
    closures_passed, closure_failures = validate_closed_findings(state_path, state)
    learning_passed, learning_failures = validate_learning_review(state_path, state)
    audit_passed, audit_failures, validity = validate_audit(state_path, state, artifact_paths)
    escapes_complete, escape_failures = validate_audit_escapes(state_path, state, require_complete=True)

    open_blocking = [
        finding for finding in state["findings"]
        if finding.get("status") == "open" and finding.get("disposition") == "blocking"
    ]
    open_recommendations = [
        finding for finding in state["findings"]
        if finding.get("status") == "open" and finding.get("disposition") == "recommendation"
    ]
    open_regressions = [item for item in state["regressions"] if item.get("status") == "open"]
    material_limitations = [item for item in state["limitations"] if item.get("material") is True]

    frozen_current_match = identity_matches(state["frozen_identity"], state["current_identity"])
    post_audit_skill_change = skill_changed_after_audit(state)
    identity_invalid = not frozen_current_match or post_audit_skill_change or audit.get("modifications_detected") is True
    signature_ok = not (
        validity == "independent"
        and audit.get("signature_required") is True
        and audit.get("signature_valid") is not True
    )

    approval_gate = all((
        audit.get("verdict") == "Aprovado",
        audit_passed,
        artifacts_passed,
        semantic_passed,
        gates_passed,
        requirements_passed,
        risk_passed,
        closures_passed,
        learning_passed,
        escapes_complete,
        not open_blocking,
        not open_regressions,
        not material_limitations,
        signature_ok,
    ))

    if blocked.get("active") is True and blocked.get("external") is True and blocked.get("alternatives_exhausted") is True:
        decision = "BLOCKED"
        reason = blocked.get("reason") or "External impediment with no safe alternative."
    elif identity_invalid:
        decision = "IDENTITY_INVALIDATED"
        reason = "Frozen and current identities diverged, or a Skill changed after audit."
    elif audit.get("validity") == "absent" or audit.get("verdict") == "not-run":
        decision = "AUDIT_REQUIRED"
        reason = "No audit is recorded for the frozen identity."
    elif approval_gate and validity == "independent":
        decision = "APPROVED"
        reason = "Operational approval released by an independent audit."
    elif approval_gate:
        decision = "INTERNALLY_APPROVED"
        reason = f"Internal approval at assurance level {validity}; independent release gate remains pending."
    elif state.get("audit_escapes") and not escapes_complete:
        if any(item.get("root_cause_completed") is not True for item in state.get("audit_escapes", [])):
            decision = "ROOT_CAUSE_ANALYSIS"
            reason = "An audit escape requires formal root-cause analysis before any further approval."
        else:
            decision = "SYSTEMIC_REMEDIATION"
            reason = "An audit escape requires Skill improvement and a reusable adversarial control before any further approval."
    elif validity == "independent" and state.get("prior_internal_approval") and open_blocking:
        related = {item.get("finding_id") for item in state.get("audit_escapes", [])}
        if not all(item.get("id") in related for item in open_blocking):
            decision = "ROOT_CAUSE_ANALYSIS"
            reason = "Independent audit refuted a prior internal approval; register audit escapes and perform root-cause analysis."
        elif any(item.get("root_cause_completed") is not True for item in state.get("audit_escapes", [])):
            decision = "ROOT_CAUSE_ANALYSIS"
            reason = "First audit escape requires formal root-cause analysis."
        elif any(item.get("skill_improvement_completed") is not True or not item.get("reusable_control_id") for item in state.get("audit_escapes", [])):
            decision = "SYSTEMIC_REMEDIATION"
            reason = "First audit escape requires Skill improvement and a reusable adversarial control."
        else:
            decision = "REMEDIATE"
            reason = "Audit escape controls are recorded; remediate the blocking findings and re-audit independently."
    elif cycle == MAX_CYCLES:
        decision = "LIMIT_REACHED"
        reason = f"Cycle {MAX_CYCLES} completed without satisfying all evidence-backed approval gates."
    else:
        history_counts = [item.get("occurrence_count", 1) for item in open_blocking if isinstance(item.get("occurrence_count", 1), int)]
        recurrence = max(history_counts, default=1)
        if recurrence >= 3:
            decision = "SYSTEMIC_REMEDIATION"
            reason = "A blocking finding persisted for three or more recorded occurrences."
        elif recurrence == 2:
            decision = "ROOT_CAUSE_ANALYSIS"
            reason = "A blocking finding recurred; formal root-cause analysis is required."
        else:
            decision = "REMEDIATE"
            reason = "One or more evidence-backed approval gates are not satisfied."

    return {
        "schema_version": 5,
        "issue": state.get("issue"),
        "cycle": cycle,
        "execution_mode": state["execution_mode"],
        "decision": decision,
        "reason": reason,
        "claimed_assurance_level": audit.get("validity"),
        "effective_assurance_level": validity,
        "open_blocking_findings": len(open_blocking),
        "open_recommendations": len(open_recommendations),
        "open_regressions": len(open_regressions),
        "material_limitations": len(material_limitations),
        "checks": {
            "audit": {"passed": audit_passed, "failures": audit_failures},
            "artifacts": {"passed": artifacts_passed, "failures": artifact_failures},
            "semantic_artifacts": {"passed": semantic_passed, "failures": semantic_failures},
            "requirements": {"passed": requirements_passed, "failures": requirement_failures},
            "gates": {"passed": gates_passed, "failures": gate_failures},
            "risk_coverage": {"passed": risk_passed, "failures": risk_failures},
            "finding_closures": {"passed": closures_passed, "failures": closure_failures},
            "learning_review": {"passed": learning_passed, "failures": learning_failures},
            "audit_escapes": {"passed": escapes_complete, "failures": escape_failures},
        },
        "identity_matches": {
            "frozen_current": frozen_current_match,
            "skill_changed_after_audit": post_audit_skill_change,
            "modifications_during_audit": audit.get("modifications_detected") is True,
        },
        "signature_ok": signature_ok,
        "internal_approval_record": ({
            "head_sha": state["frozen_identity"]["head_sha"],
            "report_sha256": audit.get("report_sha256"),
            "assurance_level": validity,
            "approved_at": audit.get("finished_at"),
        } if decision == "INTERNALLY_APPROVED" else None),
        "continue_in_same_invocation": decision not in FINAL_DECISIONS,
        "next_cycle_allowed": cycle < MAX_CYCLES and decision in {
            "REMEDIATE", "ROOT_CAUSE_ANALYSIS", "SYSTEMIC_REMEDIATION", "IDENTITY_INVALIDATED"
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    try:
        state_path = args.state.resolve()
        state = load_state(state_path)
        validate_state(state)
        result = evaluate(state_path, state)
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2

    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
