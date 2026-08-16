from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from .artifact_attestation import verify_artifact_archive
from .github_api import GitHubClient
from .identity import handoff_matches

ALLOWED_JOB_CONCLUSIONS = {"success", "skipped", "neutral"}


def _pr_snapshot(pr: dict[str, Any]) -> dict[str, Any]:
    head = pr.get("head") or {}
    base = pr.get("base") or {}
    return {
        "head_sha": head.get("sha", "") if isinstance(head, dict) else "",
        "base_sha": base.get("sha", "") if isinstance(base, dict) else "",
        "base_ref": base.get("ref", "") if isinstance(base, dict) else "",
        "merge_preview_sha": pr.get("merge_commit_sha") or "",
        "state": pr.get("state", ""),
        "merged": pr.get("merged"),
    }


def _run_path(run: dict[str, Any]) -> str:
    return str(run.get("path") or "").split("@", 1)[0].lstrip("/")


def _run_sort_key(run: dict[str, Any]) -> tuple[str, int, int]:
    return (
        str(run.get("created_at") or ""),
        int(run.get("run_attempt") or 0),
        int(run.get("id") or 0),
    )


def _latest_run(
    runs: list[Any], rel: str, head_sha: str, allowed_events: set[str]
) -> dict[str, Any] | None:
    candidates = [
        run for run in runs
        if isinstance(run, dict)
        and _run_path(run) == rel
        and run.get("head_sha") == head_sha
        and run.get("event") in allowed_events
    ]
    candidates.sort(key=_run_sort_key, reverse=True)
    return candidates[0] if candidates else None


def _validate_jobs(jobs_payload: dict[str, Any], rel: str, errors: list[str]) -> dict[str, Any]:
    jobs = jobs_payload.get("jobs", []) if isinstance(jobs_payload, dict) else []
    summary: dict[str, Any] = {"workflow": rel, "job_count": len(jobs) if isinstance(jobs, list) else 0, "jobs": []}
    if not isinstance(jobs, list) or not jobs:
        errors.append(f"live remote recheck found no jobs for {rel}")
        return summary
    for job in jobs:
        if not isinstance(job, dict):
            errors.append(f"live remote recheck found an invalid job for {rel}")
            continue
        job_summary = {
            "id": job.get("id"),
            "name": job.get("name"),
            "status": job.get("status"),
            "conclusion": job.get("conclusion"),
            "steps": [],
        }
        if job.get("status") != "completed" or job.get("conclusion") not in ALLOWED_JOB_CONCLUSIONS:
            errors.append(f"live remote recheck found a non-successful job: {rel}/{job.get('name')}")
        steps = job.get("steps") or []
        if not isinstance(steps, list) or not steps:
            errors.append(f"live remote recheck found no steps: {rel}/{job.get('name')}")
            steps = []
        for step in steps:
            if not isinstance(step, dict):
                errors.append(f"live remote recheck found an invalid step: {rel}/{job.get('name')}")
                continue
            step_summary = {
                "name": step.get("name"),
                "status": step.get("status"),
                "conclusion": step.get("conclusion"),
            }
            job_summary["steps"].append(step_summary)
            if step.get("status") != "completed" or step.get("conclusion") not in ALLOWED_JOB_CONCLUSIONS:
                errors.append(
                    f"live remote recheck found a non-successful step: "
                    f"{rel}/{job.get('name')}/{step.get('name')}"
                )
        summary["jobs"].append(job_summary)
    return summary


def live_recheck(data: dict[str, Any], snapshot: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    repository = str(data.get("repository") or "")
    pull_request = int((data.get("remote_gate") or {}).get("pull_request") or 0)
    head = str(data.get("head_sha") or "")
    issue = int(data.get("issue") or 0)
    with tempfile.TemporaryDirectory(prefix="orquestrador-recheck-") as tmp:
        client = GitHubClient(Path(tmp))
        pr, _ = client.get(f"/repos/{repository}/pulls/{pull_request}", "pr-recheck")
        runs_payload, _ = client.paginate(
            f"/repos/{repository}/actions/runs?head_sha={head}",
            "workflow-runs-recheck",
            "workflow_runs",
        )
        comments, _ = client.paginate(
            f"/repos/{repository}/issues/{pull_request}/comments",
            "pr-comments-recheck",
            None,
        )

        current = _pr_snapshot(pr if isinstance(pr, dict) else {})
        expected = {
            "head_sha": snapshot.get("head_sha"),
            "base_sha": snapshot.get("base_sha"),
            "base_ref": snapshot.get("base_ref"),
            "merge_preview_sha": snapshot.get("merge_preview_sha"),
            "state": "open",
            "merged": False,
        }
        for field, value in expected.items():
            if current.get(field) != value:
                errors.append(
                    f"live remote recheck changed {field}: expected {value!r}, got {current.get(field)!r}"
                )

        runs = runs_payload.get("workflow_runs", []) if isinstance(runs_payload, dict) else []
        checked_runs: list[dict[str, Any]] = []
        checked_jobs: list[dict[str, Any]] = []
        for workflow in snapshot.get("workflows") or []:
            if not isinstance(workflow, dict) or workflow.get("applicable") is not True:
                continue
            rel = str(workflow.get("path") or "")
            allowed_events = set(workflow.get("allowed_events") or [])
            expected_run = workflow.get("run") or {}
            latest = _latest_run(runs, rel, head, allowed_events)
            if not isinstance(latest, dict):
                errors.append(f"live remote recheck cannot find an eligible run for {rel}")
                continue
            run_id = int(latest.get("id") or 0)
            check = {
                "workflow": rel,
                "id": run_id,
                "head_sha": latest.get("head_sha"),
                "event": latest.get("event"),
                "status": latest.get("status"),
                "conclusion": latest.get("conclusion"),
                "created_at": latest.get("created_at"),
                "run_attempt": latest.get("run_attempt"),
            }
            checked_runs.append(check)
            if run_id != expected_run.get("id"):
                errors.append(
                    f"live remote recheck found a newer or replacement run for {rel}: "
                    f"expected {expected_run.get('id')}, got {run_id}"
                )
            if latest.get("status") != "completed" or latest.get("conclusion") != "success":
                errors.append(
                    f"live remote recheck latest run is not successful for {rel}: "
                    f"{latest.get('status')}/{latest.get('conclusion')}"
                )
            for field in ("head_sha", "event", "status", "conclusion"):
                if check.get(field) != expected_run.get(field):
                    errors.append(f"live remote recheck changed workflow run {run_id} field {field}")
            jobs_payload, _ = client.paginate(
                f"/repos/{repository}/actions/runs/{run_id}/jobs",
                f"run-{run_id}-jobs-recheck",
                "jobs",
            )
            checked_jobs.append(_validate_jobs(jobs_payload, rel, errors))

        snapshot_artifact_runs = {
            int(item.get("id")) for item in snapshot.get("artifact_runs") or []
            if isinstance(item, dict) and isinstance(item.get("id"), int)
        }
        current_successful_runs = {
            int(run.get("id")) for run in runs
            if isinstance(run, dict)
            and isinstance(run.get("id"), int)
            and run.get("head_sha") == head
            and run.get("status") == "completed"
            and run.get("conclusion") == "success"
        }
        if current_successful_runs != snapshot_artifact_runs:
            errors.append(
                "live remote recheck successful-run inventory changed: "
                f"expected {sorted(snapshot_artifact_runs)}, got {sorted(current_successful_runs)}"
            )

        current_artifacts: dict[int, dict[str, Any]] = {}
        for run_id in sorted(current_successful_runs):
            payload, _ = client.paginate(
                f"/repos/{repository}/actions/runs/{run_id}/artifacts",
                f"run-{run_id}-artifacts-recheck",
                "artifacts",
            )
            for artifact in payload.get("artifacts", []) if isinstance(payload, dict) else []:
                if isinstance(artifact, dict) and isinstance(artifact.get("id"), int):
                    current_artifacts[int(artifact["id"])] = artifact
        expected_artifacts = {
            int(item.get("id")): item for item in snapshot.get("artifacts") or []
            if isinstance(item, dict) and isinstance(item.get("id"), int)
        }
        current_digest_ids = {
            artifact_id for artifact_id, item in current_artifacts.items()
            if isinstance(item.get("digest"), str) and str(item.get("digest")).startswith("sha256:")
        }
        if set(expected_artifacts) != current_digest_ids:
            errors.append(
                "live remote recheck artifact inventory changed: "
                f"expected {sorted(expected_artifacts)}, got {sorted(current_digest_ids)}"
            )
        artifact_checks: list[dict[str, Any]] = []
        for artifact_id, expected_artifact in expected_artifacts.items():
            current_artifact = current_artifacts.get(artifact_id)
            if not isinstance(current_artifact, dict):
                continue
            for field in ("name", "digest", "expired"):
                if expected_artifact.get(field) != current_artifact.get(field):
                    errors.append(f"live remote recheck changed artifact {artifact_id} field {field}")
            if current_artifact.get("expired") is True:
                errors.append(f"live remote recheck artifact {artifact_id} is expired")
            archive, _ = client.download_artifact(
                repository, artifact_id, f"artifact-{artifact_id}-archive-recheck"
            )
            recomputed = verify_artifact_archive(
                archive,
                artifact_id=artifact_id,
                run_id=int(expected_artifact.get("run_id")),
                head_sha=head,
            )
            artifact_checks.append({"id": artifact_id, "attestation": recomputed})
            if expected_artifact.get("attestation") != recomputed:
                errors.append(f"live remote recheck artifact {artifact_id} attestation changed")
            if recomputed.get("verified") is not True and expected_artifact.get("kind_verified") is True:
                errors.append(f"live remote recheck artifact {artifact_id} is no longer verifiable")

        current_handoff = None
        pr_body = str(pr.get("body") or "") if isinstance(pr, dict) else ""
        if handoff_matches(pr_body, issue, head):
            current_handoff = {
                "issue": issue,
                "head_sha": head,
                "location": "pull-request-body",
                "url": pr.get("html_url", "") if isinstance(pr, dict) else "",
            }
        if current_handoff is None and isinstance(comments, list):
            for comment in reversed(comments):
                if not isinstance(comment, dict):
                    continue
                if handoff_matches(str(comment.get("body") or ""), issue, head):
                    current_handoff = {
                        "issue": issue,
                        "head_sha": head,
                        "location": "pull-request-comment",
                        "url": comment.get("html_url", ""),
                    }
                    break
        current_handoff = current_handoff or {"issue": issue, "head_sha": "", "location": "", "url": ""}
        if current_handoff != snapshot.get("issue_handoff"):
            errors.append("live remote recheck issue handoff changed or disappeared")

    return errors, {
        "pr": current,
        "runs": checked_runs,
        "jobs": checked_jobs,
        "artifacts": artifact_checks,
        "issue_handoff": current_handoff,
    }
