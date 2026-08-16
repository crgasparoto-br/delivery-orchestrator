from __future__ import annotations

from pathlib import Path
import re
import subprocess
from typing import Any

from .schema_validation import validate_against_schema
from .specification import DECISION_KINDS, detect_scope_reduction_matches, extract_candidates
from .utils import load_json, resolve, sha256_file, text

DISCRIMINANT_TYPES = {
    "boundary-call", "fault-injection", "negative-control", "mutation", "counterexample",
    "dependency-outage", "persistence-boundary", "visual-accessibility",
}


def _decision_source(
    decision: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    oid: str,
    errors: list[str],
) -> dict[str, Any] | None:
    source_id = str(decision.get("decision_source_id") or "")
    source = sources.get(source_id)
    if not source:
        errors.append(f"semantic obligation {oid} scope decision references unknown source {source_id}")
        return None
    if source.get("kind") not in DECISION_KINDS:
        errors.append(
            f"semantic obligation {oid} scope decision source {source_id} is not a canonical issue decision"
        )
    if decision.get("decision_source_sha256") != source.get("sha256"):
        errors.append(f"semantic obligation {oid} scope decision source hash mismatch")
    if len(str(decision.get("decision_locator") or "").strip()) < 4:
        errors.append(f"semantic obligation {oid} scope decision locator is missing")
    return source



READ_MODEL_PATTERN = re.compile(
    r"\b(history|historical|timeline|version|versioning|pagination|authorship|origin|supersession|vigency|previous records|hist[oó]ric\w*|linha do tempo|vers[aã]o|vers[oõ]es|pagina[cç][aã]o|autoria|origem|supersess[aã]o|vig[eê]ncia|registros anteriores)\b",
    re.IGNORECASE,
)
CANONICAL_PATTERN = re.compile(
    r"\b(canonical|source of truth|consistent|coherent|can[oô]nic\w*|fonte de verdade|consisten\w*|coeren\w*)\b",
    re.IGNORECASE,
)
DOC_TRANSITION_PATTERN = re.compile(
    r"\b(route|redirect|legacy|deprecated|retire|replace|rename|workspace|rota|redirecion\w*|legado|obsoleto|aposent\w*|substitu\w*|renome\w*)\b",
    re.IGNORECASE,
)
CURRENT_STATE_MARKERS = re.compile(
    r"\b(current|currently|existing|baseline|today|atual|atualmente|existente|linha de base|hoje)\b",
    re.IGNORECASE,
)
RETIREMENT_MARKERS = re.compile(
    r"\b(historical|previous|retired|legacy|redirect|compatibility|hist[oó]ric\w*|anterior|aposentad\w*|legado|redirecion\w*|compatibilidade)\b",
    re.IGNORECASE,
)


def _gate_status(value: Any, label: str, inferred: bool, errors: list[str]) -> str:
    if not isinstance(value, dict):
        errors.append(f"{label} gate is missing")
        return ""
    status = str(value.get("status") or "")
    reason = str(value.get("applicability_reason") or "").strip()
    if status == "pending":
        errors.append(f"{label} gate is still pending")
    elif status == "not-applicable":
        if inferred:
            errors.append(f"{label} gate cannot be not-applicable for the canonical contract")
        if len(reason) < 20:
            errors.append(f"{label} not-applicable decision requires an objective rationale")
    elif status == "passed":
        if len(reason) < 12:
            errors.append(f"{label} passed gate requires an applicability rationale")
    else:
        errors.append(f"{label} gate has invalid status")
    return status


def _validate_refs(
    refs: set[str], known: set[str], label: str, errors: list[str]
) -> None:
    missing = refs - known
    if missing:
        errors.append(f"{label} references unknown ids: {sorted(missing)}")


def _git_grep_terms(repo: Path, head: str, terms: list[str]) -> list[tuple[str, int, str, str]]:
    results: list[tuple[str, int, str, str]] = []
    seen: set[tuple[str, int, str, str]] = set()
    for term in terms:
        proc = subprocess.run(
            ["git", "grep", "-n", "-I", "-F", term, head, "--", "*.md", "*.mdx", "*.rst", "*.adoc"],
            cwd=repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if proc.returncode not in (0, 1):
            raise RuntimeError(proc.stderr.strip() or f"git grep failed for {term}")
        for raw in proc.stdout.splitlines():
            # <sha>:path:line:text or path:line:text depending on git version.
            parts = raw.split(":", 3)
            if len(parts) != 4:
                continue
            _, path, line_text, line_value = parts
            try:
                line = int(line_text)
            except ValueError:
                continue
            item = (path, line, line_value, term)
            if item not in seen:
                seen.add(item)
                results.append(item)
    return sorted(results)

def validate_requirement_closure(
    data: dict[str, Any],
    evidence_dir: Path,
    errors: list[str],
) -> dict[str, int]:
    ref = data.get("requirement_closure") or {}
    closure_path = resolve(evidence_dir, str(ref.get("path", "")))
    closure = load_json(closure_path, "requirement closure", errors)
    if not closure:
        return {
            "semantic_obligations": 0,
            "domain_inventory_values": 0,
            "observable_assertions": 0,
            "specification_sources": 0,
        }

    skill_root = Path(__file__).resolve().parents[2]
    validate_against_schema(
        closure,
        skill_root / "schemas" / "requirement-closure.schema.json",
        "requirement closure",
        errors,
    )
    if ref.get("sha256") != sha256_file(closure_path):
        errors.append("requirement closure hash differs from evidence")

    snapshot_ref = closure.get("specification_snapshot") or {}
    snapshot_path = resolve(closure_path.parent, str(snapshot_ref.get("path", "")))
    if not snapshot_path.is_file():
        errors.append(f"specification snapshot missing: {snapshot_path}")
        snapshot: dict[str, Any] = {}
        sources: dict[str, dict[str, Any]] = {}
        candidates: list[dict[str, Any]] = []
    else:
        if snapshot_ref.get("sha256") != sha256_file(snapshot_path):
            errors.append("specification snapshot hash differs from requirement closure")
        specification_errors: list[str] = []
        snapshot, sources, candidates = extract_candidates(snapshot_path, specification_errors)
        errors.extend(specification_errors)
    if closure.get("primary_issue_source_id") != snapshot.get("primary_source_id"):
        errors.append("requirement closure primary issue source differs from specification snapshot")
    packet_snapshot = Path(str(data.get("packet_path") or "")) / "specification-snapshot.json"
    if not packet_snapshot.is_file():
        errors.append("audit packet does not contain the canonical specification snapshot")
    elif snapshot_ref.get("sha256") != sha256_file(packet_snapshot):
        errors.append("requirement closure specification snapshot differs from audit packet")

    requirements = [item for item in data.get("requirements") or [] if isinstance(item, dict)]
    req_ids = {str(item.get("id")) for item in requirements if item.get("id")}
    evidence_items = [item for item in data.get("evidence") or [] if isinstance(item, dict)]
    evidence_by_id = {str(item.get("id")): item for item in evidence_items if item.get("id")}
    scenarios = [item for item in data.get("scenarios") or [] if isinstance(item, dict)]
    scenario_ids = {str(item.get("id")) for item in scenarios if item.get("id")}

    candidate_by_key = {str(item.get("candidate_key")): item for item in candidates}
    obligations = [item for item in closure.get("obligations") or [] if isinstance(item, dict)]
    obligation_by_id: dict[str, dict[str, Any]] = {}
    obligation_by_key: dict[str, dict[str, Any]] = {}
    linked_requirements: set[str] = set()
    deferred_targets: set[int] = set()
    for item in obligations:
        oid = text(item.get("id"), "requirement closure obligation id", errors)
        if oid in obligation_by_id:
            errors.append(f"duplicate semantic obligation id: {oid}")
        obligation_by_id[oid] = item
        key = str(item.get("candidate_key") or "")
        if key in obligation_by_key:
            errors.append(f"duplicate semantic obligation candidate key: {key}")
        obligation_by_key[key] = item
        candidate = candidate_by_key.get(key)
        if not candidate:
            errors.append(f"semantic obligation {oid} has no canonical source candidate")
        else:
            for field in ("source_id", "source_sha256", "source_line", "source_text"):
                if item.get(field) != candidate.get(field):
                    errors.append(f"semantic obligation {oid} {field} differs from canonical source")
            if set(item.get("flags") or []) != set(candidate.get("flags") or []):
                errors.append(f"semantic obligation {oid} flags differ from canonical source")

        disposition = item.get("disposition")
        flags = set(item.get("flags") or [])
        requirement_ids = set(item.get("requirement_ids") or [])
        inventory_ids = set(item.get("inventory_ids") or [])
        assertion_ids = set(item.get("assertion_ids") or [])
        decision = item.get("scope_decision")
        if disposition == "pending":
            errors.append(f"semantic obligation {oid} is still pending")
        elif disposition == "covered":
            if decision is not None:
                errors.append(f"covered semantic obligation {oid} cannot carry a scope decision")
            if not requirement_ids:
                errors.append(f"semantic obligation {oid} must map to at least one requirement")
            invalid = requirement_ids - req_ids
            if invalid:
                errors.append(f"semantic obligation {oid} references unknown requirements: {sorted(invalid)}")
            linked_requirements.update(requirement_ids)
            if flags & {"exhaustive", "source-catalog"} and not inventory_ids:
                errors.append(f"semantic obligation {oid} requires a closed domain inventory")
            if flags & {"observable", "semantic-effect"} and not assertion_ids:
                errors.append(f"semantic obligation {oid} requires an observable assertion")
            discriminant_flags = flags & {
                "freshness", "atomicity", "aftermath", "review-surface", "semantic-effect"
            }
            if discriminant_flags and not assertion_ids:
                errors.append(
                    f"semantic obligation {oid} requires a discriminant closure assertion "
                    f"for {sorted(discriminant_flags)}"
                )
            if "review-surface" in flags and not inventory_ids:
                errors.append(f"semantic obligation {oid} requires a review field/action inventory")
        elif disposition in {"deferred", "not-applicable"}:
            if requirement_ids or inventory_ids or assertion_ids:
                errors.append(f"{disposition} semantic obligation {oid} cannot claim implementation coverage")
            if not isinstance(decision, dict):
                errors.append(f"{disposition} semantic obligation {oid} requires a canonical scope decision")
            else:
                _decision_source(decision, sources, oid, errors)
                if disposition == "deferred":
                    target = decision.get("target_issue")
                    if not isinstance(target, int) or target <= 0:
                        errors.append(f"deferred semantic obligation {oid} requires a target issue")
                    else:
                        deferred_targets.add(target)
                    if decision.get("parent_issue_must_remain_open") is not True:
                        errors.append(f"deferred semantic obligation {oid} must keep the parent issue open")
                elif len(str(item.get("rationale", "")).strip()) < 20:
                    errors.append(f"not-applicable semantic obligation {oid} requires an objective rationale")
        else:
            errors.append(f"semantic obligation {oid} has invalid disposition")

    canonical_keys = set(candidate_by_key)
    obligation_keys = set(obligation_by_key)
    if canonical_keys != obligation_keys:
        errors.append(
            "canonical specification obligation coverage differs; "
            f"missing={sorted(canonical_keys-obligation_keys)}, extra={sorted(obligation_keys-canonical_keys)}"
        )

    missing_requirement_links = req_ids - linked_requirements
    if missing_requirement_links:
        errors.append(
            "requirements without source obligation mapping: "
            f"{sorted(missing_requirement_links)}"
        )

    coverage_items = [item for item in closure.get("source_coverage") or [] if isinstance(item, dict)]
    coverage_by_source = {str(item.get("source_id")): item for item in coverage_items}
    textual_sources = {sid for sid, source in sources.items() if source.get("textual") is True}
    if set(coverage_by_source) != textual_sources:
        errors.append(
            "source coverage inventory differs from canonical textual sources; "
            f"missing={sorted(textual_sources-set(coverage_by_source))}, "
            f"extra={sorted(set(coverage_by_source)-textual_sources)}"
        )
    for sid in textual_sources:
        coverage = coverage_by_source.get(sid) or {}
        source = sources[sid]
        expected_ids = {
            oid for oid, item in obligation_by_id.items() if item.get("source_id") == sid
        }
        if coverage.get("source_sha256") != source.get("sha256"):
            errors.append(f"source coverage hash mismatch: {sid}")
        if coverage.get("candidate_count") != len(expected_ids):
            errors.append(f"source coverage candidate count mismatch: {sid}")
        if set(coverage.get("obligation_ids") or []) != expected_ids:
            errors.append(f"source coverage obligation mapping mismatch: {sid}")
        if coverage.get("unmapped_candidate_keys"):
            errors.append(f"source coverage has unmapped candidates: {sid}")

    inventories = [item for item in closure.get("domain_inventories") or [] if isinstance(item, dict)]
    inventory_by_id: dict[str, dict[str, Any]] = {}
    total_values = 0
    for item in inventories:
        iid = text(item.get("id"), "domain inventory id", errors)
        if iid in inventory_by_id:
            errors.append(f"duplicate domain inventory id: {iid}")
        inventory_by_id[iid] = item
        values = [value for value in item.get("values") or [] if isinstance(value, dict)]
        total_values += len(values)
        value_names = [str(value.get("value", "")) for value in values]
        if len(value_names) != len(set(value_names)):
            errors.append(f"domain inventory {iid} contains duplicate values")
        if item.get("unmapped_values"):
            errors.append(f"domain inventory {iid} has unmapped values: {item.get('unmapped_values')}")
        if item.get("closed_world") is True and item.get("fallback_policy") == "open-world-generic":
            errors.append(f"closed domain inventory {iid} cannot rely on a generic open-world fallback")
        for value in values:
            name = str(value.get("value", ""))
            producer_refs = set(value.get("producer_evidence") or [])
            consumer_refs = set(value.get("consumer_evidence") or [])
            scenario_refs = set(value.get("scenario_ids") or [])
            invalid_evidence = (producer_refs | consumer_refs) - set(evidence_by_id)
            if invalid_evidence:
                errors.append(f"domain inventory {iid} value {name} references unknown evidence: {sorted(invalid_evidence)}")
            invalid_scenarios = scenario_refs - scenario_ids
            if invalid_scenarios:
                errors.append(f"domain inventory {iid} value {name} references unknown scenarios: {sorted(invalid_scenarios)}")

    assertions = [item for item in closure.get("observable_assertions") or [] if isinstance(item, dict)]
    assertion_by_id: dict[str, dict[str, Any]] = {}
    for item in assertions:
        aid = text(item.get("id"), "observable assertion id", errors)
        if aid in assertion_by_id:
            errors.append(f"duplicate observable assertion id: {aid}")
        assertion_by_id[aid] = item
        requirement_refs = set(item.get("requirement_ids") or [])
        obligation_refs = set(item.get("obligation_ids") or [])
        evidence_refs = set(item.get("evidence_ids") or [])
        negative_refs = set(item.get("negative_control_evidence") or [])
        scenario_refs = set(item.get("scenario_ids") or [])
        if requirement_refs - req_ids:
            errors.append(f"observable assertion {aid} references unknown requirements")
        if obligation_refs - set(obligation_by_id):
            errors.append(f"observable assertion {aid} references unknown obligations")
        if evidence_refs - set(evidence_by_id):
            errors.append(f"observable assertion {aid} references unknown evidence")
        if scenario_refs - scenario_ids:
            errors.append(f"observable assertion {aid} references unknown scenarios")
        if negative_refs - set(evidence_by_id):
            errors.append(f"observable assertion {aid} references unknown negative-control evidence")
        for eid in negative_refs:
            if evidence_by_id.get(eid, {}).get("type") not in DISCRIMINANT_TYPES:
                errors.append(f"observable assertion {aid} negative control {eid} is not discriminant")

    for oid, obligation in obligation_by_id.items():
        for iid in obligation.get("inventory_ids") or []:
            if iid not in inventory_by_id:
                errors.append(f"semantic obligation {oid} references unknown inventory {iid}")
        for aid in obligation.get("assertion_ids") or []:
            assertion = assertion_by_id.get(aid)
            if not assertion:
                errors.append(f"semantic obligation {oid} references unknown assertion {aid}")
            elif oid not in (assertion.get("obligation_ids") or []):
                errors.append(f"semantic obligation {oid} assertion {aid} does not link back")

    obligation_text = "\n".join(str(item.get("source_text") or "") for item in obligations)
    repo = Path(str(data.get("repository_path") or ""))

    structural_flags = {"structural", "forbidden-implementation", "canonical-path", "dependency-independence", "precedence"}
    structural_obligation_ids = {
        oid for oid, item in obligation_by_id.items()
        if structural_flags.intersection(item.get("flags") or []) and item.get("disposition") == "covered"
    }
    structural = closure.get("structural_invariant_closures")
    if structural is None and not structural_obligation_ids:
        structural = {"status": "not-applicable", "applicability_reason": "Legacy closure with no structural obligations.", "entries": [], "unresolved_invariants": []}
        structural_status = "not-applicable"
    else:
        structural = structural or {}
        structural_status = _gate_status(
            structural, "structural invariant closure", bool(structural_obligation_ids), errors
        )
    structural_entries = [item for item in structural.get("entries") or [] if isinstance(item, dict)]
    linked_structural: set[str] = set()
    for item in structural_entries:
        sid = text(item.get("id"), "structural invariant closure id", errors)
        requirement_refs = set(item.get("requirement_ids") or [])
        obligation_refs = set(item.get("obligation_ids") or [])
        evidence_refs = set(item.get("evidence_ids") or [])
        negative_refs = set(item.get("negative_control_evidence") or [])
        scenario_refs = set(item.get("scenario_ids") or [])
        _validate_refs(requirement_refs, req_ids, f"structural invariant {sid} requirements", errors)
        _validate_refs(obligation_refs, set(obligation_by_id), f"structural invariant {sid} obligations", errors)
        _validate_refs(evidence_refs, set(evidence_by_id), f"structural invariant {sid} evidence", errors)
        _validate_refs(negative_refs, set(evidence_by_id), f"structural invariant {sid} negative controls", errors)
        _validate_refs(scenario_refs, scenario_ids, f"structural invariant {sid} scenarios", errors)
        for eid in negative_refs:
            if evidence_by_id.get(eid, {}).get("type") not in DISCRIMINANT_TYPES:
                errors.append(f"structural invariant {sid} negative control {eid} is not discriminant")
        linked_structural.update(obligation_refs & structural_obligation_ids)
        if item.get("kind") == "canonical-path-parity":
            if not str(item.get("canonical_path") or "").strip():
                errors.append(f"structural invariant {sid} canonical path parity lacks canonical_path")
            if not item.get("competing_paths"):
                errors.append(f"structural invariant {sid} canonical path parity lacks competing_paths")
    if structural_status == "passed" and structural_obligation_ids - linked_structural:
        errors.append(
            "structural invariant closure does not cover obligations: "
            f"{sorted(structural_obligation_ids - linked_structural)}"
        )
    if structural.get("unresolved_invariants"):
        errors.append(
            f"structural invariant closure has unresolved invariants: {structural.get('unresolved_invariants')}"
        )

    read_model = closure.get("read_model_closures") or {}
    read_inferred = bool(READ_MODEL_PATTERN.search(obligation_text))
    read_status = _gate_status(read_model, "read model closure", read_inferred, errors)
    read_entries = [item for item in read_model.get("entries") or [] if isinstance(item, dict)]
    if read_status == "passed" and not read_entries:
        errors.append("read model closure passed without producer-contract-consumer entries")
    if read_model.get("unconsumed_outputs"):
        errors.append(f"read model closure has unconsumed outputs: {read_model.get('unconsumed_outputs')}")
    if read_model.get("unmapped_required_fields"):
        errors.append(f"read model closure has unmapped required fields: {read_model.get('unmapped_required_fields')}")
    read_ids: set[str] = set()
    for item in read_entries:
        rid = text(item.get("id"), "read model closure id", errors)
        if rid in read_ids:
            errors.append(f"duplicate read model closure id: {rid}")
        read_ids.add(rid)
        _validate_refs(set(item.get("requirement_ids") or []), req_ids, f"read model closure {rid} requirements", errors)
        evidence_refs = set().union(
            set(item.get("producer_evidence") or []),
            set(item.get("public_projection_evidence") or []),
            set(item.get("consumer_evidence") or []),
            set(item.get("visible_surface_evidence") or []),
        )
        _validate_refs(evidence_refs, set(evidence_by_id), f"read model closure {rid} evidence", errors)
        _validate_refs(set(item.get("scenario_ids") or []), scenario_ids, f"read model closure {rid} scenarios", errors)
        negative_refs = set(item.get("negative_control_evidence") or [])
        _validate_refs(negative_refs, set(evidence_by_id), f"read model closure {rid} negative controls", errors)
        for eid in negative_refs:
            if evidence_by_id.get(eid, {}).get("type") not in DISCRIMINANT_TYPES:
                errors.append(f"read model closure {rid} negative control {eid} is not discriminant")

    canonical = closure.get("canonical_source_consistency") or {}
    canonical_inferred = bool(CANONICAL_PATTERN.search(obligation_text))
    canonical_status = _gate_status(canonical, "canonical source consistency", canonical_inferred, errors)
    canonical_entries = [item for item in canonical.get("entries") or [] if isinstance(item, dict)]
    if canonical_status == "passed" and not canonical_entries:
        errors.append("canonical source consistency passed without semantic field entries")
    if canonical.get("unverified_surfaces"):
        errors.append(f"canonical source consistency has unverified surfaces: {canonical.get('unverified_surfaces')}")
    if canonical.get("missing_divergent_tests"):
        errors.append(f"canonical source consistency lacks divergent tests: {canonical.get('missing_divergent_tests')}")
    canonical_ids: set[str] = set()
    for item in canonical_entries:
        cid = text(item.get("id"), "canonical source consistency id", errors)
        if cid in canonical_ids:
            errors.append(f"duplicate canonical source consistency id: {cid}")
        canonical_ids.add(cid)
        alternatives = set(item.get("alternative_sources") or [])
        if str(item.get("canonical_source") or "") in alternatives:
            errors.append(f"canonical source consistency {cid} lists the canonical source as an alternative")
        fixture = item.get("divergent_fixture") or {}
        canonical_value = str(fixture.get("canonical_value") or "")
        alternative_values = {str(value) for value in fixture.get("alternative_values") or []}
        if canonical_value in alternative_values:
            errors.append(f"canonical source consistency {cid} fixture is not divergent")
        _validate_refs(set(item.get("evidence_ids") or []), set(evidence_by_id), f"canonical source consistency {cid} evidence", errors)
        _validate_refs(set(item.get("scenario_ids") or []), scenario_ids, f"canonical source consistency {cid} scenarios", errors)
        negative_refs = set(item.get("negative_control_evidence") or [])
        _validate_refs(negative_refs, set(evidence_by_id), f"canonical source consistency {cid} negative controls", errors)
        for eid in negative_refs:
            if evidence_by_id.get(eid, {}).get("type") not in DISCRIMINANT_TYPES:
                errors.append(f"canonical source consistency {cid} negative control {eid} is not discriminant")

    documentation = closure.get("documentation_consistency") or {}
    documentation_inferred = bool(DOC_TRANSITION_PATTERN.search(obligation_text))
    documentation_status = _gate_status(documentation, "documentation consistency", documentation_inferred, errors)
    if documentation_status == "passed":
        old_terms = [str(value) for value in documentation.get("old_contract_terms") or []]
        new_terms = [str(value) for value in documentation.get("new_contract_terms") or []]
        if not old_terms or not new_terms:
            errors.append("documentation consistency requires old and new contract terms")
        if documentation.get("searched_outside_diff") is not True:
            errors.append("documentation consistency must search outside the diff")
        search_evidence = set(documentation.get("search_evidence") or [])
        _validate_refs(search_evidence, set(evidence_by_id), "documentation consistency search evidence", errors)
        if not search_evidence:
            errors.append("documentation consistency requires search evidence")
        if documentation.get("unresolved_contradictions"):
            errors.append(
                f"documentation consistency has unresolved contradictions: {documentation.get('unresolved_contradictions')}"
            )
        occurrences = [item for item in documentation.get("occurrences") or [] if isinstance(item, dict)]
        recorded = {
            (str(item.get("path")), int(item.get("line") or 0), str(item.get("text")), str(item.get("term")))
            for item in occurrences
        }
        if repo.is_dir() and (repo / ".git").exists() and old_terms:
            try:
                detected = set(_git_grep_terms(repo, str(data.get("head_sha") or "HEAD"), old_terms))
                if detected != recorded:
                    errors.append(
                        "documentation consistency occurrence inventory differs from the frozen repository; "
                        f"missing={sorted(detected-recorded)}, extra={sorted(recorded-detected)}"
                    )
            except Exception as exc:
                errors.append(f"cannot recompute documentation consistency search: {exc}")
        for item in occurrences:
            occurrence_label = f"{item.get('path')}:{item.get('line')}"
            if item.get("term") not in old_terms:
                errors.append(f"documentation occurrence {occurrence_label} references an unknown old contract term")
            _validate_refs(set(item.get("evidence_ids") or []), set(evidence_by_id), f"documentation occurrence {occurrence_label} evidence", errors)
            line_text = str(item.get("text") or "")
            classification = item.get("classification")
            current_claim = bool(CURRENT_STATE_MARKERS.search(line_text)) and not bool(RETIREMENT_MARKERS.search(line_text))
            if current_claim and classification != "contradiction":
                errors.append(
                    f"documentation occurrence {occurrence_label} describes retired behavior as current and must be classified as contradiction"
                )
            if classification == "contradiction":
                errors.append(f"documentation occurrence {occurrence_label} remains contradictory")

    scope_review = closure.get("scope_reduction_review") or {}
    if scope_review.get("status") != "passed":
        errors.append("scope reduction review must be passed")
    recorded_matches = [item for item in scope_review.get("matches") or [] if isinstance(item, dict)]
    repo = Path(str(data.get("repository_path") or ""))
    if repo.is_dir() and (repo / ".git").exists():
        try:
            detected_matches = detect_scope_reduction_matches(
                repo, str(data.get("base_ref") or ""), str(data.get("head_sha") or "")
            )
        except Exception as exc:
            errors.append(f"cannot recompute scope reduction review: {exc}")
            detected_matches = []
        detected_keys = {(item["path"], item["line"], item["text"]) for item in detected_matches}
        recorded_keys = {
            (str(item.get("path")), item.get("line"), str(item.get("text")))
            for item in recorded_matches
        }
        if detected_keys != recorded_keys:
            errors.append(
                "scope reduction review differs from the frozen diff; "
                f"missing={sorted(detected_keys-recorded_keys)}, extra={sorted(recorded_keys-detected_keys)}"
            )
    for index, match in enumerate(recorded_matches):
        disposition = match.get("disposition")
        source_id = match.get("decision_source_id")
        if disposition == "canonical-decision":
            source = sources.get(str(source_id or ""))
            if not source or source.get("kind") not in DECISION_KINDS:
                errors.append(f"scope reduction match {index} lacks a canonical decision source")
        elif disposition == "not-a-reduction":
            if source_id is not None:
                errors.append(f"scope reduction match {index} marked not-a-reduction cannot cite a decision source")
            if len(str(match.get("rationale") or "").strip()) < 30:
                errors.append(f"scope reduction match {index} requires a specific non-reduction rationale")
        else:
            errors.append(f"scope reduction match {index} has invalid disposition")

    pass_c = closure.get("pass_c") or {}
    if pass_c.get("status") != "passed":
        errors.append("Pass C semantic closure must be passed")
    if set(pass_c.get("requirement_ids") or []) != req_ids:
        errors.append("Pass C must cover exactly all requirements")
    if set(pass_c.get("obligation_ids") or []) != set(obligation_by_id):
        errors.append("Pass C must cover exactly all source obligations")
    pass_c_evidence = set(pass_c.get("evidence") or [])
    if not pass_c_evidence or pass_c_evidence - set(evidence_by_id):
        errors.append("Pass C must reference valid evidence")
    if pass_c.get("rederived_without_pr_description") is not True:
        errors.append("Pass C must rederive the contract without using the PR description")
    if pass_c.get("reviewed_user_visible_semantics") is not True:
        errors.append("Pass C must review user-visible semantic qualifiers")
    if pass_c.get("reviewed_producer_consumer_parity") is not True:
        errors.append("Pass C must review producer-consumer parity")
    if pass_c.get("reviewed_all_specification_sources") is not True:
        errors.append("Pass C must review every canonical specification source")

    handoff = data.get("handoff") or {}
    if deferred_targets:
        if handoff.get("issue_completion") != "partial":
            errors.append("deferred obligations require a partial handoff")
        if handoff.get("parent_issue_must_remain_open") is not True:
            errors.append("partial handoff must keep the parent issue open")
        remaining = set(handoff.get("remaining_issue_ids") or [])
        if deferred_targets - remaining:
            errors.append(f"partial handoff omits deferred target issues: {sorted(deferred_targets-remaining)}")
    else:
        if handoff.get("issue_completion") != "complete":
            errors.append("handoff must be complete when no obligation is deferred")
        if handoff.get("remaining_issue_ids"):
            errors.append("complete handoff cannot list remaining issues")
        if handoff.get("parent_issue_must_remain_open") is not False:
            errors.append("complete handoff must not force the parent issue open")

    return {
        "semantic_obligations": len(obligations),
        "domain_inventory_values": total_values,
        "observable_assertions": len(assertions),
        "specification_sources": len(sources),
        "read_model_closures": len(read_entries),
        "canonical_source_entries": len(canonical_entries),
        "documentation_occurrences": len(documentation.get("occurrences") or []),
    }
