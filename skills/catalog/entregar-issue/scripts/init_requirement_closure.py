#!/usr/bin/env python3
"""Create a fail-closed semantic obligation inventory from a canonical specification snapshot."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from orchestrator_gate.specification import extract_candidates, sha256_file


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--specification-snapshot", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    snapshot_path = Path(args.specification_snapshot).resolve()
    errors: list[str] = []
    snapshot, sources, candidates = extract_candidates(snapshot_path, errors)
    if errors:
        raise SystemExit("; ".join(errors))
    if not candidates:
        raise SystemExit("no obligation candidates found; normalize the canonical specification before continuing")

    obligations: list[dict[str, object]] = []
    by_source: dict[str, list[str]] = {sid: [] for sid, source in sources.items() if source.get("textual") is True}
    for index, candidate in enumerate(candidates, start=1):
        oid = f"OBL-{index:03d}"
        by_source[str(candidate["source_id"])].append(oid)
        obligations.append({
            "id": oid,
            **candidate,
            "disposition": "pending",
            "requirement_ids": [],
            "inventory_ids": [],
            "assertion_ids": [],
            "scope_decision": None,
            "rationale": "",
        })

    source_coverage = []
    for sid, obligation_ids in by_source.items():
        source = sources[sid]
        source_coverage.append({
            "source_id": sid,
            "source_sha256": source.get("sha256"),
            "candidate_count": len(obligation_ids),
            "obligation_ids": obligation_ids,
            "unmapped_candidate_keys": [],
        })

    output = {
        "schema_version": 3,
        "specification_snapshot": {
            "path": str(snapshot_path),
            "sha256": sha256_file(snapshot_path),
        },
        "primary_issue_source_id": snapshot.get("primary_source_id"),
        "obligations": obligations,
        "source_coverage": source_coverage,
        "domain_inventories": [],
        "observable_assertions": [],
        "structural_invariant_closures": {
            "status": "pending" if any(
                {"structural", "forbidden-implementation", "canonical-path", "dependency-independence", "precedence"}.intersection(item.get("flags") or [])
                for item in obligations
            ) else "not-applicable",
            "applicability_reason": "Structural or implementation-form obligations were detected." if any(
                {"structural", "forbidden-implementation", "canonical-path", "dependency-independence", "precedence"}.intersection(item.get("flags") or [])
                for item in obligations
            ) else "No structural, canonical-path, precedence, dependency-independence, or forbidden-implementation obligation was detected.",
            "entries": [],
            "unresolved_invariants": [],
        },
        "read_model_closures": {
            "status": "pending",
            "applicability_reason": "",
            "entries": [],
            "unconsumed_outputs": [],
            "unmapped_required_fields": [],
        },
        "canonical_source_consistency": {
            "status": "pending",
            "applicability_reason": "",
            "entries": [],
            "unverified_surfaces": [],
            "missing_divergent_tests": [],
        },
        "documentation_consistency": {
            "status": "pending",
            "applicability_reason": "",
            "old_contract_terms": [],
            "new_contract_terms": [],
            "occurrences": [],
            "unresolved_contradictions": [],
            "searched_outside_diff": False,
            "search_evidence": [],
        },
        "scope_reduction_review": {"status": "pending", "matches": []},
        "pass_c": {
            "status": "pending",
            "requirement_ids": [],
            "obligation_ids": [],
            "evidence": [],
            "rederived_without_pr_description": False,
            "reviewed_user_visible_semantics": False,
            "reviewed_producer_consumer_parity": False,
            "reviewed_all_specification_sources": False,
        },
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
