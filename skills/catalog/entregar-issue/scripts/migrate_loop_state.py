#!/usr/bin/env python3
"""Migrate Issue Loop Engineer state files from schema v2/v3/v4 or legacy v5 to strengthened v5."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

CORE_ARTIFACTS = (
    "execution-context", "specification-snapshot", "requirement-closure", "risk-profile",
    "documentation-impact", "gate-report", "source-manifest", "requirements-rederivation",
    "coverage-matrix", "applicability-ledger", "controller-audit-report", "cycle-history",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--execution-mode", choices=("standard", "implement-pendencies"), default=None)
    args = parser.parse_args()

    payload = json.loads(args.state.read_text(encoding="utf-8"))
    version = payload.get("schema_version")
    if version not in {2, 3, 4, 5}:
        raise SystemExit(f"unsupported schema_version: {version}")
    if version == 5:
        strengthened = False
        for requirement in payload.get("requirements", []):
            if isinstance(requirement, dict) and "negative_control_evidence" not in requirement:
                requirement["negative_control_evidence"] = []
                strengthened = True
        if strengthened:
            payload["requirements_inventory_complete"] = False
            payload["gate_inventory_complete"] = False
            audit = payload.setdefault("audit", {})
            audit["verdict"] = "not-run"
            audit["validity"] = "absent"
            audit["identity"] = None
        output = args.out or args.state
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(output)
        return 0

    mode = args.execution_mode or payload.get("execution_mode") or "standard"
    payload["schema_version"] = 5
    payload["execution_mode"] = mode

    audit = payload.setdefault("audit", {})
    audit.setdefault("implementation_conclusions_included", False)
    audit.setdefault("implementation_narrative_included", False)
    for key in (
        "report_path", "report_sha256", "requirements_rederivation_path",
        "requirements_rederivation_sha256", "coverage_matrix_path", "coverage_matrix_sha256",
        "source_manifest_path", "source_manifest_sha256",
    ):
        audit.setdefault(key, None)

    for requirement in payload.get("requirements", []):
        if not isinstance(requirement, dict):
            continue
        requirement.setdefault("origin", "legacy-unmapped")
        requirement.setdefault("statement", f"Legacy requirement {requirement.get('id', 'unknown')} requiring rederivation")
        legacy_evidence = requirement.get("evidence")
        if isinstance(legacy_evidence, str) and legacy_evidence:
            requirement["evidence"] = [legacy_evidence]
        elif not isinstance(legacy_evidence, list):
            requirement["evidence"] = []
        requirement.setdefault("negative_controls", [])
        requirement.setdefault("negative_control_evidence", [])
        requirement.setdefault("regression_evidence", [])

    frozen = payload.get("frozen_identity") or {}
    head_sha = frozen.get("head_sha", "legacy-unmapped")
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, list):
        artifacts = []
    declared = {item.get("name") for item in artifacts if isinstance(item, dict)}
    for name in CORE_ARTIFACTS:
        if name not in declared:
            artifacts.append({
                "name": name,
                "required": True,
                "status": "missing",
                "path": None,
                "sha256": None,
                "head_sha": head_sha,
            })
    if frozen.get("pull_request") is not None and "remote-gate" not in declared:
        artifacts.append({
            "name": "remote-gate", "required": True, "status": "missing",
            "path": None, "sha256": None, "head_sha": head_sha,
        })
    payload["artifacts"] = artifacts
    payload.setdefault("risk_families", [{
        "name": "documentation",
        "applicable": True,
        "basis": "Migrated state requires complete risk reclassification.",
        "required_gates": [],
        "required_subskills": ["documentacao-repositorio"],
    }])
    payload.setdefault("subskill_results", [])
    payload.setdefault("changed_files", [])
    payload.setdefault("prior_internal_approval", None)
    payload.setdefault("audit_escapes", [])
    payload.setdefault("adversarial_controls", [])

    findings = payload.get("findings", [])
    required_review = mode == "implement-pendencies" or bool(findings)
    review = payload.get("learning_review") if isinstance(payload.get("learning_review"), dict) else {}
    review.setdefault("reviewed_finding_ids", [])
    review.setdefault("items", [])
    review.setdefault("ledger_path", None)
    review.setdefault("ledger_sha256", None)
    review["required"] = required_review
    if required_review:
        review["completed"] = False
    else:
        review.setdefault("completed", True)
    payload["learning_review"] = review

    # Migration intentionally invalidates approval until v5 evidence is rebuilt.
    payload["requirements_inventory_complete"] = False
    payload["gate_inventory_complete"] = False
    audit["verdict"] = "not-run"
    audit["validity"] = "absent"
    audit["identity"] = None

    output = args.out or args.state
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
