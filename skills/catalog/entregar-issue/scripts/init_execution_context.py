#!/usr/bin/env python3
import argparse
import json
import uuid
from pathlib import Path

from planning_contract_runtime import validate_execution_context


def main():
    parser = argparse.ArgumentParser(description="Initialize a delivery execution context")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--repo-path", required=True)
    parser.add_argument("--issue", type=int, required=True)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--pull-request", type=int)
    parser.add_argument("--mode", default="delivery")
    parser.add_argument("--profile", choices=["light", "standard", "critical"], default="standard")
    parser.add_argument("--implementation-context-id")
    parser.add_argument("--cycle", type=int, default=1)
    parser.add_argument("--artifacts-dir")
    parser.add_argument("--controller-mode", choices=["none", "delivery-single-invocation", "issue-loop-single-invocation"], default="none")
    parser.add_argument("--controller-context-id")
    parser.add_argument("--controller-cycle-limit", type=int, choices=range(1, 11))
    parser.add_argument("--return-control-to")
    parser.add_argument("--allow-workflow-changes", action="store_true")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    out = Path(args.out).resolve()
    artifacts_dir = args.artifacts_dir or str(out.parent)
    context_id = args.implementation_context_id or f"delivery-{uuid.uuid4()}"
    payload = {
        "schema_version": 1,
        "contract_version": "2026-08-06.2",
        "repository": args.repository,
        "repo_path": args.repo_path,
        "issue": args.issue,
        "base_ref": args.base_ref,
        "branch": args.branch,
        "pull_request": args.pull_request,
        "mode": args.mode,
        "execution_profile": args.profile,
        "implementation_context_id": context_id,
        "cycle": args.cycle,
        "controller_cycle": args.cycle if args.controller_mode != "none" else None,
        "controller_state_revision": 1 if args.controller_mode != "none" else None,
        "cycle_authority": "entregar-issue",
        "controller_context_sha256": "0" * 64 if args.controller_mode != "none" else None,
        "head_sha": None,
        "base_sha": None,
        "merge_preview_sha": None,
        "artifacts_dir": artifacts_dir,
        "controller_mode": None if args.controller_mode == "none" else args.controller_mode,
        "controller_context_id": args.controller_context_id,
        "controller_cycle_limit": args.controller_cycle_limit,
        "return_control_to": args.return_control_to,
        "workflow_change_authorized": bool(args.allow_workflow_changes),
        "manual_approval_workflow_authorized": False,
        "remote_action_mode": "observe-only",
        "publish_policy": "single-final-candidate",
        "permissions": {
            "may_write_code": True,
            "may_update_issue": False,
            "may_merge": False,
            "may_execute_destructive_actions": False,
        },
    }

    if args.controller_mode != "none":
        if not args.controller_context_id:
            parser.error("--controller-context-id is required in delivery controller mode")
        payload["controller_cycle_limit"] = args.controller_cycle_limit or 10
        payload["return_control_to"] = args.return_control_to or "entregar-issue"

    try:
        validate_execution_context(payload)
    except ValueError as exc:
        print(str(exc))
        raise SystemExit(1) from exc

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
