#!/usr/bin/env python3
"""Project the canonical controller context into a delivery execution context."""
from __future__ import annotations
import argparse, hashlib, json, uuid
from pathlib import Path
from planning_contract_runtime import validate_controller_context, validate_execution_context

ROOT = Path(__file__).resolve().parents[1]


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller-context", required=True)
    parser.add_argument("--profile", choices=["light", "standard", "critical"], default="standard")
    parser.add_argument("--artifacts-dir")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    source_path = Path(args.controller_context).resolve()
    source = load(source_path)
    validate_controller_context(source)
    out = Path(args.out).resolve()
    policy = source["workflow_policy"]
    payload = {
        "schema_version": 1,
        "contract_version": source["contract_version"],
        "repository": source["repository"],
        "repo_path": source["repository_path"],
        "issue": source["issue"],
        "base_ref": source["base_ref"],
        "branch": source["branch"],
        "pull_request": source.get("pull_request"),
        "mode": "delivery",
        "execution_profile": args.profile,
        "implementation_context_id": f"delivery-{uuid.uuid4()}",
        "cycle": source["controller_cycle"],
        "controller_cycle": source["controller_cycle"],
        "controller_state_revision": source["controller_revision"],
        "cycle_authority": "entregar-issue",
        "head_sha": source["identity"].get("head_sha"),
        "base_sha": source["identity"].get("base_sha"),
        "merge_preview_sha": source["identity"].get("merge_preview_sha"),
        "artifacts_dir": args.artifacts_dir or str(out.parent),
        "controller_mode": "delivery-single-invocation",
        "controller_context_id": source["controller_context_id"],
        "controller_context_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "controller_cycle_limit": source["controller_cycle_limit"],
        "return_control_to": "entregar-issue",
        "workflow_change_authorized": policy["workflow_change_authorized"],
        "manual_approval_workflow_authorized": policy["manual_approval_workflow_authorized"],
        "remote_action_mode": policy["remote_action_mode"],
        "publish_policy": policy["publish_policy"],
        "permissions": source["permissions"],
    }
    validate_execution_context(payload)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(out)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
