#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys

from planning_contract_runtime import validate_controller_context
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", *args], cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "git command failed")
    return proc.stdout.strip()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository")
    parser.add_argument("--repo-path")
    parser.add_argument("--issue", type=int)
    parser.add_argument("--base-ref")
    parser.add_argument("--branch")
    parser.add_argument("--pull-request", type=int)
    parser.add_argument("--implementation-context-id")
    parser.add_argument("--controller-context")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    controller = None
    if args.controller_context:
        controller_path = Path(args.controller_context).resolve()
        controller = json.loads(controller_path.read_text(encoding="utf-8"))
        try:
            validate_controller_context(controller)
        except ValueError as exc:
            print(f"error: invalid controller context: {exc}", file=sys.stderr)
            return 2
        args.repository = controller["repository"]
        args.repo_path = controller["repository_path"]
        args.issue = controller["issue"]
        args.base_ref = controller["base_ref"]
        args.branch = controller["branch"]
        args.pull_request = controller.get("pull_request")
    missing = [name for name, value in (("repository", args.repository), ("repo-path", args.repo_path), ("issue", args.issue), ("base-ref", args.base_ref), ("branch", args.branch)) if value in (None, "")]
    if missing:
        print("error: missing required inputs: " + ", ".join(missing), file=sys.stderr)
        return 2
    repo = Path(args.repo_path).resolve()
    if not (repo / ".git").exists():
        print(f"error: not a Git repository: {repo}", file=sys.stderr)
        return 2
    try:
        head = git(repo, "rev-parse", "HEAD")
        base = git(repo, "rev-parse", args.base_ref)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    timestamp = now()
    implementation_context_id = args.implementation_context_id or str(uuid4())
    if len(implementation_context_id.strip()) < 8:
        print("error: implementation context id must have at least 8 characters", file=sys.stderr)
        return 2
    state = {
        "schema_version": 3,
        "contract_version": "2026-08-06.2",
        "controller_mode": "delivery-single-invocation" if controller else None,
        "controller_context_id": controller.get("controller_context_id") if controller else None,
        "controller_state_revision": controller.get("controller_revision") if controller else None,
        "controller_cycle": controller.get("controller_cycle", 1) if controller else 1,
        "cycle_authority": "entregar-issue",
        "repository": args.repository,
        "repository_path": str(repo),
        "issue": args.issue,
        "base_ref": args.base_ref,
        "branch": args.branch,
        "pull_request": args.pull_request,
        "state": "pendente",
        "cycle": controller.get("controller_cycle", 1) if controller else 1,
        "head_sha": head,
        "base_sha": base,
        "merge_preview_sha": "",
        "current_artifacts": {},
        "invalidated_artifacts": [],
        "findings": [],
        "implementation_context_id": implementation_context_id,
        "external_audit": None,
        "audit_history": [],
        "invalidated_audits": [],
        "transitions": [{
            "at": timestamp,
            "from": None,
            "to": "pendente",
            "reason": "delivery initialized",
            "head_sha": head,
            "base_sha": base,
        }],
        "updated_at": timestamp,
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
