#!/usr/bin/env python3
"""Collect a fail-closed GitHub PR/workflow snapshot for one exact SHA.

All derived fields remain reproducible from hashed raw API payloads. Required
artifact kinds are accepted only when the GitHub artifact contains an embedded
`orquestrador-artifact.json` attestation that matches the run and final SHA.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from orchestrator_gate.artifact_attestation import (
    ALLOWED_ARTIFACT_KINDS,
    verify_artifact_archive,
)
from orchestrator_gate.github_api import GitHubClient, sha256_file
from orchestrator_gate.identity import handoff_matches
from orchestrator_gate.workflow_rules import (
    WorkflowParseError,
    load_workflow,
    workflow_applicability,
)

ALLOWED_JOB_CONCLUSIONS = {"success", "skipped", "neutral"}

def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", *args], cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "git command failed")
    return proc.stdout.strip()


def normalize_run_path(value: str) -> str:
    return value.split("@", 1)[0].lstrip("/")


def run_sort_key(value: dict[str, Any]) -> tuple[str, int, int]:
    return (
        str(value.get("created_at", "")),
        int(value.get("run_attempt") or 0),
        int(value.get("id") or 0),
    )


def pr_snapshot(pr: dict[str, Any]) -> dict[str, Any]:
    head = pr.get("head") or {}
    base = pr.get("base") or {}
    return {
        "state": pr.get("state", ""),
        "draft": pr.get("draft"),
        "merged": pr.get("merged"),
        "mergeable": pr.get("mergeable"),
        "mergeable_state": pr.get("mergeable_state", ""),
        "head_sha": head.get("sha", "") if isinstance(head, dict) else "",
        "base_ref": base.get("ref", "") if isinstance(base, dict) else "",
        "base_sha": base.get("sha", "") if isinstance(base, dict) else "",
        "merge_preview_sha": pr.get("merge_commit_sha") or "",
    }


def jobs_are_successful(jobs_payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    jobs = jobs_payload.get("jobs", []) if isinstance(jobs_payload, dict) else []
    details: list[dict[str, Any]] = []
    if not isinstance(jobs, list) or not jobs:
        return False, {"job_count": 0, "jobs": []}
    valid = True
    for job in jobs:
        if not isinstance(job, dict):
            valid = False
            continue
        steps = job.get("steps") or []
        step_results: list[dict[str, Any]] = []
        if not isinstance(steps, list) or not steps:
            valid = False
            steps = []
        for step in steps:
            if not isinstance(step, dict):
                valid = False
                continue
            status = step.get("status")
            conclusion = step.get("conclusion")
            step_ok = status == "completed" and conclusion in ALLOWED_JOB_CONCLUSIONS
            valid = valid and step_ok
            step_results.append({
                "name": step.get("name", ""),
                "status": status,
                "conclusion": conclusion,
                "ok": step_ok,
            })
        status = job.get("status")
        conclusion = job.get("conclusion")
        job_ok = status == "completed" and conclusion in ALLOWED_JOB_CONCLUSIONS and bool(step_results)
        valid = valid and job_ok
        details.append({
            "id": job.get("id"),
            "name": job.get("name", ""),
            "status": status,
            "conclusion": conclusion,
            "ok": job_ok,
            "steps": step_results,
        })
    return valid, {"job_count": len(jobs), "jobs": details}


def read_artifact_attestation(archive: Path, artifact: dict[str, Any], run: dict[str, Any], head_sha: str) -> dict[str, Any]:
    return verify_artifact_archive(
        archive,
        artifact_id=int(artifact.get("id")) if isinstance(artifact.get("id"), int) else None,
        run_id=int(run.get("id")),
        head_sha=head_sha,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--pull-request", required=True, type=int)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--issue", required=True, type=int)
    parser.add_argument("--out", required=True)
    parser.add_argument("--fixture-dir")
    parser.add_argument(
        "--artifact-kind",
        action="append",
        default=[],
        help="artifact-name=expected-kind; validates the embedded artifact attestation and never assigns a kind by name",
    )
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    out = Path(args.out).resolve()
    raw_dir = out.parent / (out.stem + "-raw")
    fixture_dir = Path(args.fixture_dir).resolve() if args.fixture_dir else None
    if not (repo / ".git").exists():
        print(f"error: not a Git repository: {repo}", file=sys.stderr)
        return 2
    try:
        if git(repo, "rev-parse", "HEAD") != args.head_sha:
            raise RuntimeError("local HEAD differs from requested SHA")
        if git(repo, "status", "--porcelain=v1"):
            raise RuntimeError("working tree is dirty")
        changed_files = git(repo, "diff", "--name-only", f"{args.base_ref}...{args.head_sha}").splitlines()
        client = GitHubClient(raw_dir, fixture_dir)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    expected_kinds: dict[str, str] = {}
    for value in args.artifact_kind:
        if "=" not in value:
            print(f"error: invalid --artifact-kind {value!r}", file=sys.stderr)
            return 2
        name, kind = value.split("=", 1)
        if kind not in ALLOWED_ARTIFACT_KINDS - {"other"}:
            print(f"error: invalid artifact kind {kind!r}", file=sys.stderr)
            return 2
        expected_kinds[name] = kind

    owner_repo = args.repository
    pr_endpoint = f"/repos/{owner_repo}/pulls/{args.pull_request}"
    raw_payloads: list[dict[str, str]] = []
    try:
        pr_before, raw = client.get(pr_endpoint, "pr-before")
        raw_payloads.append(raw)
        runs_before_payload, raws = client.paginate(
            f"/repos/{owner_repo}/actions/runs?head_sha={args.head_sha}",
            "workflow-runs-before",
            "workflow_runs",
        )
        raw_payloads.extend(raws)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3

    runs_before = runs_before_payload.get("workflow_runs", []) if isinstance(runs_before_payload, dict) else []
    run_by_path: dict[str, list[dict[str, Any]]] = {}
    for run in runs_before if isinstance(runs_before, list) else []:
        if isinstance(run, dict):
            run_by_path.setdefault(normalize_run_path(str(run.get("path", ""))), []).append(run)

    applicability_dir = raw_dir / "applicability"
    workflows: list[dict[str, Any]] = []
    applicable_count = 0
    selected_run_ids: set[int] = set()
    workflow_paths = sorted(
        [*(repo / ".github" / "workflows").glob("*.yml"), *(repo / ".github" / "workflows").glob("*.yaml")]
    ) if (repo / ".github" / "workflows").is_dir() else []
    for path in workflow_paths:
        rel = path.relative_to(repo).as_posix()
        try:
            workflow = load_workflow(path)
        except WorkflowParseError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 4
        applicable, rationale, applicability, allowed_events = workflow_applicability(
            workflow, changed_files, args.base_ref
        )
        if any(
            isinstance(event, dict) and event.get("invalid")
            for event in (applicability.get("events") or {}).values()
        ):
            print(f"error: invalid PR filters in workflow {rel}", file=sys.stderr)
            return 4
        evidence_file = applicability_dir / (path.name + ".json")
        write_json(evidence_file, applicability)
        item: dict[str, Any] = {
            "path": rel,
            "sha256": sha256_file(path),
            "name": str(workflow.get("name") or path.stem),
            "triggers_pull_request": bool(allowed_events or (applicability.get("events") or {})),
            "allowed_events": sorted(allowed_events),
            "applicable": applicable,
            "rationale": rationale,
            "applicability_evidence": str(evidence_file),
            "run": None,
        }
        if applicable:
            applicable_count += 1
            candidates = [
                run for run in run_by_path.get(rel, [])
                if run.get("head_sha") == args.head_sha and run.get("event") in allowed_events
            ]
            candidates.sort(key=run_sort_key, reverse=True)
            if candidates:
                selected = candidates[0]
                run_id = int(selected.get("id"))
                try:
                    jobs, raws = client.paginate(
                        f"/repos/{owner_repo}/actions/runs/{run_id}/jobs",
                        f"run-{run_id}-jobs",
                        "jobs",
                    )
                    raw_payloads.extend(raws)
                except RuntimeError as exc:
                    print(f"error: {exc}", file=sys.stderr)
                    return 3
                jobs_checked, jobs_summary = jobs_are_successful(jobs)
                output_file = raw_dir / f"run-{run_id}-summary.json"
                write_json(output_file, {"run": selected, "jobs": jobs, "jobs_summary": jobs_summary})
                item["run"] = {
                    "id": run_id,
                    "event": selected.get("event", ""),
                    "head_sha": selected.get("head_sha", ""),
                    "status": selected.get("status", ""),
                    "conclusion": selected.get("conclusion", ""),
                    "created_at": selected.get("created_at", ""),
                    "run_attempt": selected.get("run_attempt"),
                    "jobs_checked": jobs_checked,
                    "job_count": jobs_summary["job_count"],
                    "steps_checked": jobs_checked,
                    "output_path": str(output_file),
                    "payload_sha256": sha256_file(output_file),
                }
                selected_run_ids.add(run_id)
        workflows.append(item)

    no_applicable = applicable_count == 0
    no_applicable_file = raw_dir / "no-applicable-pr-workflows.json"
    if no_applicable:
        write_json(no_applicable_file, {
            "changed_files": changed_files,
            "workflow_decisions": [
                {
                    "path": item["path"],
                    "triggers_pull_request": item["triggers_pull_request"],
                    "applicable": item["applicable"],
                    "rationale": item["rationale"],
                }
                for item in workflows
            ],
        })

    # Artifact metadata is collected from every successful run on the final SHA,
    # but semantic kinds only become valid through an embedded attestation.
    successful_runs = [
        run for run in runs_before
        if isinstance(run, dict)
        and run.get("head_sha") == args.head_sha
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
    ]
    artifact_runs: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    for run in successful_runs:
        run_id = int(run.get("id"))
        run_file = raw_dir / f"artifact-run-{run_id}.json"
        write_json(run_file, run)
        artifact_runs.append({
            "id": run_id,
            "path": normalize_run_path(str(run.get("path", ""))),
            "name": run.get("name", ""),
            "event": run.get("event", ""),
            "head_sha": run.get("head_sha", ""),
            "status": run.get("status", ""),
            "conclusion": run.get("conclusion", ""),
            "output_path": str(run_file),
            "payload_sha256": sha256_file(run_file),
        })
        try:
            artifact_payload, raws = client.paginate(
                f"/repos/{owner_repo}/actions/runs/{run_id}/artifacts",
                f"run-{run_id}-artifacts",
                "artifacts",
            )
            raw_payloads.extend(raws)
        except RuntimeError as exc:
            print(f"error: failed to collect artifacts for run {run_id}: {exc}", file=sys.stderr)
            return 3
        for artifact in artifact_payload.get("artifacts", []) if isinstance(artifact_payload, dict) else []:
            if not isinstance(artifact, dict):
                continue
            digest = artifact.get("digest")
            if not isinstance(digest, str) or not digest.startswith("sha256:"):
                continue
            artifact_id = int(artifact.get("id"))
            name = str(artifact.get("name", ""))
            metadata_file = raw_dir / f"artifact-{artifact_id}.json"
            write_json(metadata_file, artifact)
            attestation: dict[str, Any]
            archive_path = ""
            archive_sha256 = ""
            try:
                archive, raw = client.download_artifact(owner_repo, artifact_id, f"artifact-{artifact_id}-archive")
                raw_payloads.append(raw)
                archive_path = str(archive)
                archive_sha256 = sha256_file(archive)
                attestation = read_artifact_attestation(archive, artifact, run, args.head_sha)
            except RuntimeError as exc:
                attestation = {"verified": False, "kind": "other", "error": str(exc), "checks": []}
            if name in expected_kinds and attestation.get("kind") != expected_kinds[name]:
                attestation["verified"] = False
                attestation["error"] = (
                    str(attestation.get("error") or "") + f"; expected kind {expected_kinds[name]}"
                ).strip("; ")
                attestation["kind"] = "other"
            artifacts.append({
                "id": artifact_id,
                "name": name,
                "kind": attestation.get("kind", "other"),
                "kind_verified": attestation.get("verified") is True,
                "attestation": attestation,
                "run_id": run_id,
                "head_sha": args.head_sha,
                "digest": digest,
                "expired": artifact.get("expired"),
                "size_in_bytes": artifact.get("size_in_bytes"),
                "created_at": artifact.get("created_at"),
                "updated_at": artifact.get("updated_at"),
                "purpose": "GitHub Actions artifact collected for the final SHA",
                "output_path": str(metadata_file),
                "payload_sha256": sha256_file(metadata_file),
                "archive_path": archive_path,
                "archive_sha256": archive_sha256,
            })

    try:
        comments, raws = client.paginate(
            f"/repos/{owner_repo}/issues/{args.pull_request}/comments",
            "pr-comments",
            None,
        )
        raw_payloads.extend(raws)
    except RuntimeError as exc:
        print(f"error: failed to collect PR comments: {exc}", file=sys.stderr)
        return 3
    needle_sha = args.head_sha
    handoff = None
    body = str(pr_before.get("body") or "") if isinstance(pr_before, dict) else ""
    if handoff_matches(body, args.issue, needle_sha):
        handoff = {
            "issue": args.issue,
            "head_sha": args.head_sha,
            "location": "pull-request-body",
            "url": pr_before.get("html_url", ""),
        }
    if handoff is None and isinstance(comments, list):
        for comment in reversed(comments):
            if not isinstance(comment, dict):
                continue
            content = str(comment.get("body") or "")
            if handoff_matches(content, args.issue, needle_sha):
                handoff = {
                    "issue": args.issue,
                    "head_sha": args.head_sha,
                    "location": "pull-request-comment",
                    "url": comment.get("html_url", ""),
                }
                break
    handoff = handoff or {"issue": args.issue, "head_sha": "", "location": "", "url": ""}

    try:
        runs_after_payload, raws = client.paginate(
            f"/repos/{owner_repo}/actions/runs?head_sha={args.head_sha}",
            "workflow-runs-after",
            "workflow_runs",
        )
        raw_payloads.extend(raws)
        pr_after, raw = client.get(pr_endpoint, "pr-after")
        raw_payloads.append(raw)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3

    before = pr_snapshot(pr_before if isinstance(pr_before, dict) else {})
    after = pr_snapshot(pr_after if isinstance(pr_after, dict) else {})
    runs_after = runs_after_payload.get("workflow_runs", []) if isinstance(runs_after_payload, dict) else []
    selected_after = {
        int(run.get("id")): {
            "status": run.get("status"),
            "conclusion": run.get("conclusion"),
            "event": run.get("event"),
            "head_sha": run.get("head_sha"),
        }
        for run in runs_after
        if isinstance(run, dict) and isinstance(run.get("id"), int) and int(run.get("id")) in selected_run_ids
    }
    runs_after_by_path: dict[str, list[dict[str, Any]]] = {}
    for run in runs_after if isinstance(runs_after, list) else []:
        if isinstance(run, dict):
            runs_after_by_path.setdefault(normalize_run_path(str(run.get("path", ""))), []).append(run)
    for workflow_item in workflows:
        if workflow_item.get("applicable") is not True:
            continue
        rel = str(workflow_item.get("path") or "")
        allowed = set(workflow_item.get("allowed_events") or [])
        candidates = [
            run for run in runs_after_by_path.get(rel, [])
            if run.get("head_sha") == args.head_sha and run.get("event") in allowed
        ]
        candidates.sort(key=run_sort_key, reverse=True)
        selected_before = workflow_item.get("run") or {}
        if not candidates:
            print(f"error: applicable workflow has no current PR run after collection: {rel}", file=sys.stderr)
            return 5
        latest = candidates[0]
        if latest.get("id") != selected_before.get("id"):
            print(f"error: a newer workflow run appeared during collection: {rel}", file=sys.stderr)
            return 5
        if latest.get("status") != "completed" or latest.get("conclusion") != "success":
            print(f"error: latest workflow run is not successful after collection: {rel}", file=sys.stderr)
            return 5
    snapshot = {
        "schema_version": 4,
        "provider": "github",
        "repository": args.repository,
        "pull_request": args.pull_request,
        "base_ref": args.base_ref,
        "head_sha": args.head_sha,
        "head_sha_after": after["head_sha"],
        "base_sha": before["base_sha"],
        "base_sha_after": after["base_sha"],
        "merge_preview_sha": before["merge_preview_sha"],
        "merge_preview_sha_after": after["merge_preview_sha"],
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "source": "fixture" if fixture_dir else ("gh-api" if client.gh else "github-rest-api"),
        "provenance": {
            "collector": "collect_remote_gate.py",
            "collector_version": 4,
            "collector_sha256": sha256_file(Path(__file__).resolve()),
            "raw_payloads": raw_payloads,
        },
        "pr": {"before": before, "after": after},
        "changed_files": changed_files,
        "workflows": workflows,
        "selected_runs_after": selected_after,
        "no_applicable_pr_workflows": no_applicable,
        "no_applicable_evidence": str(no_applicable_file) if no_applicable else "",
        "artifact_runs": artifact_runs,
        "artifacts": artifacts,
        "issue_handoff": handoff,
    }
    write_json(out, snapshot)
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
