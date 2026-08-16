#!/usr/bin/env python3
"""Run one repository gate and emit immutable stdout/stderr and a JSON attestation."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_head(cwd: Path) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=cwd, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--cwd", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--command", required=True)
    parser.add_argument("--allow-non-git", action="store_true")
    args = parser.parse_args()

    cwd = args.cwd.resolve()
    actual_head = git_head(cwd)
    if actual_head is None and not args.allow_non_git:
        print("cwd is not a readable Git worktree", file=sys.stderr)
        return 2
    if actual_head is not None and actual_head != args.head_sha:
        print(f"head mismatch: expected {args.head_sha}, observed {actual_head}", file=sys.stderr)
        return 2

    args.out_dir.mkdir(parents=True, exist_ok=True)
    started_at = now()
    completed = subprocess.run(
        ["bash", "-lc", args.command],
        cwd=cwd,
        capture_output=True,
        check=False,
    )
    finished_at = now()

    stdout_path = args.out_dir / "stdout.log"
    stderr_path = args.out_dir / "stderr.log"
    stdout_path.write_bytes(completed.stdout)
    stderr_path.write_bytes(completed.stderr)

    attestation = {
        "schema_version": 1,
        "name": args.name,
        "command": args.command,
        "cwd": str(cwd),
        "exit_code": completed.returncode,
        "started_at": started_at,
        "finished_at": finished_at,
        "head_sha": actual_head or args.head_sha,
        "stdout_sha256": digest(completed.stdout),
        "stderr_sha256": digest(completed.stderr),
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
        "executor": "entregar-issue/run_attested_gate.py@2",
    }
    attestation_path = args.out_dir / "attestation.json"
    attestation_path.write_text(json.dumps(attestation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    result = {
        "attestation_path": str(attestation_path),
        "attestation_sha256": hashlib.sha256(attestation_path.read_bytes()).hexdigest(),
        **attestation,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
