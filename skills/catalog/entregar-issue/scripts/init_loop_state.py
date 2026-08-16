#!/usr/bin/env python3
"""Initialize a schema v5 Issue Loop Engineer state file."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

CORE_ARTIFACTS = (
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
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--issue", type=int, required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--merge-preview-sha")
    parser.add_argument("--pull-request", type=int)
    parser.add_argument("--issue-snapshot-sha256", required=True)
    parser.add_argument("--diff-sha256", required=True)
    parser.add_argument("--skills-sha256", required=True)
    parser.add_argument("--cycle", type=int, default=1)
    parser.add_argument(
        "--execution-mode",
        choices=("standard", "implement-pendencies"),
        default="standard",
    )
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    captured_at = now()
    identity = {
        "repository": args.repository,
        "issue": args.issue,
        "pull_request": args.pull_request,
        "branch": args.branch,
        "head_sha": args.head_sha,
        "base_sha": args.base_sha,
        "merge_preview_sha": args.merge_preview_sha,
        "issue_snapshot_sha256": args.issue_snapshot_sha256,
        "diff_sha256": args.diff_sha256,
        "skills_sha256": args.skills_sha256,
        "captured_at": captured_at,
    }
    artifacts = [
        {
            "name": name,
            "required": True,
            "status": "missing",
            "path": None,
            "sha256": None,
            "head_sha": args.head_sha,
        }
        for name in CORE_ARTIFACTS
    ]
    if args.pull_request is not None:
        artifacts.append({
            "name": "remote-gate",
            "required": True,
            "status": "missing",
            "path": None,
            "sha256": None,
            "head_sha": args.head_sha,
        })

    learning_required = args.execution_mode == "implement-pendencies"
    payload = {
        "schema_version": 5,
        "contract_version": "2026-08-06.2",
        "controller_revision": 1,
        "metrics": {
            "issue_full_reads": 0,
            "documentation_full_scans": 0,
            "subskill_calls": 0,
            "full_suites": 0,
            "freezes": 0,
            "remote_collections": 0,
            "reused_stages": 0,
            "avoidable_invalidations": 0
        },
        "issue": args.issue,
        "cycle": args.cycle,
        "state": "frozen",
        "single_invocation_mode": True,
        "controller_mode": "delivery-single-invocation",
        "execution_mode": args.execution_mode,
        "frozen_identity": identity,
        "current_identity": dict(identity),
        "audit": {
            "validity": "absent",
            "verdict": "not-run",
            "identity": None,
            "implementation_context_id": None,
            "audit_context_id": None,
            "started_at": None,
            "finished_at": None,
            "read_only": False,
            "requirements_rederived": False,
            "neutral_packet_sha256": None,
            "implementation_conclusions_included": False,
            "implementation_narrative_included": False,
            "report_path": None,
            "report_sha256": None,
            "requirements_rederivation_path": None,
            "requirements_rederivation_sha256": None,
            "coverage_matrix_path": None,
            "coverage_matrix_sha256": None,
            "source_manifest_path": None,
            "source_manifest_sha256": None,
            "modifications_detected": False,
            "isolation_proven": False,
            "external_context_proven": False,
            "signature_required": False,
            "signature_valid": None,
        },
        "requirements_inventory_complete": False,
        "requirements": [],
        "gate_inventory_complete": False,
        "gates": [],
        "findings": [],
        "regressions": [],
        "limitations": [],
        "artifacts": artifacts,
        "risk_families": [{
            "name": "documentation",
            "applicable": True,
            "basis": "Documentation governance is mandatory in every cycle.",
            "required_gates": [],
            "required_subskills": ["documentacao-repositorio"],
        }],
        "subskill_results": [],
        "changed_files": [],
        "skill_changes": [],
        "operational_amendments": [],
        "prior_internal_approval": None,
        "audit_escapes": [],
        "adversarial_controls": [],
        "learning_review": {
            "required": learning_required,
            "completed": not learning_required,
            "reviewed_finding_ids": [],
            "items": [],
            "ledger_path": None,
            "ledger_sha256": None,
        },
        "blocked": {
            "active": False,
            "external": False,
            "alternatives_exhausted": False,
            "reason": None,
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
