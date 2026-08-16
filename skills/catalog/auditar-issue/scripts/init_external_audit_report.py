#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--issue", required=True, type=int)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--merge-preview-sha", required=True)
    parser.add_argument("--orchestration-cycle", required=True, type=int)
    parser.add_argument("--implementation-context-id", required=True)
    parser.add_argument("--audit-context-id", required=True)
    parser.add_argument(
        "--context-proof-kind",
        required=True,
        choices=["chatgpt-conversation-id", "agent-run-id", "tool-attestation"],
    )
    parser.add_argument("--context-proof-value", required=True)
    parser.add_argument("--context-proof-issuer", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--prior-internal-head-sha")
    parser.add_argument("--prior-internal-report-sha256")
    parser.add_argument("--prior-internal-assurance-level", choices=["controller-adversarial", "isolated-within-run"])
    parser.add_argument("--prior-internal-approved-at")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.audit_context_id == args.implementation_context_id:
        parser.error("audit-context-id must differ from implementation-context-id")
    if args.context_proof_value != args.audit_context_id:
        parser.error("context-proof-value must equal audit-context-id")
    timestamp = datetime.now(timezone.utc).isoformat()
    prior_values = [
        args.prior_internal_head_sha, args.prior_internal_report_sha256,
        args.prior_internal_assurance_level, args.prior_internal_approved_at,
    ]
    if any(prior_values) and not all(prior_values):
        parser.error("all prior-internal-* arguments are required together")
    prior_internal_approval = None
    if all(prior_values):
        prior_internal_approval = {
            "head_sha": args.prior_internal_head_sha,
            "report_sha256": args.prior_internal_report_sha256,
            "assurance_level": args.prior_internal_assurance_level,
            "approved_at": args.prior_internal_approved_at,
        }
    report = {
        "schema_version": 3,
        "report_id": str(uuid4()),
        "generated_by": "auditar-issue",
        "repository": args.repository,
        "issue": args.issue,
        "base_ref": args.base_ref,
        "head_sha": args.head_sha,
        "head_sha_after": "",
        "base_sha": args.base_sha,
        "base_sha_after": "",
        "merge_preview_sha": args.merge_preview_sha,
        "merge_preview_sha_after": "",
        "orchestration_cycle": args.orchestration_cycle,
        "implementation_context_id": args.implementation_context_id,
        "audit_context_id": args.audit_context_id,
        "source_context_proof": {
            "kind": args.context_proof_kind,
            "value": args.context_proof_value,
            "issuer": args.context_proof_issuer,
            "issued_at": timestamp,
        },
        "same_conversation": False,
        "independent": True,
        "neutral_packet": {
            "implementation_conclusions_included": False,
            "implementation_narrative_included": False,
            "allowed_contents": ["canonical-sources", "identity", "diff", "source", "tests", "raw-evidence"],
        },
        "prior_internal_approval": prior_internal_approval,
        "issued_at": timestamp,
        "verdict": "rejected",
        "findings": [],
        "evidence": [],
        "limitations": [],
        "origin": args.origin,
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))
    print("draft created; fill after-values, evidence, verdict and findings, then sign with sign_external_audit_report.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
