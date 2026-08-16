from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .artifact_attestation import verify_artifact_archive
from .identity import handoff_matches
from .risk_validation import required_artifact_kinds
from .utils import git, is_nonempty, load_json, resolve, sha256_file, text
from .workflow_rules import WorkflowParseError, load_workflow, workflow_applicability

ALLOWED_JOB_CONCLUSIONS = {"success", "skipped", "neutral"}


def normalize_ref(value: Any, repo: Path) -> str:
    ref = str(value or "").strip()
    for prefix in ("refs/heads/",):
        if ref.startswith(prefix):
            return ref[len(prefix):]
    if ref.startswith("refs/remotes/"):
        parts = ref.split("/", 3)
        return parts[3] if len(parts) == 4 else ref
    try:
        remotes = set(git(repo, "remote").splitlines())
    except Exception:
        remotes = {"origin", "upstream"}
    for remote in remotes | {"origin", "upstream"}:
        prefix = remote + "/"
        if ref.startswith(prefix):
            return ref[len(prefix):]
    return ref


def _pr_snapshot(pr: dict[str, Any]) -> dict[str, Any]:
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


def _load_raw_payloads(
    provenance: dict[str, Any], evidence_dir: Path, errors: list[str]
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    raw_items = provenance.get("raw_payloads") or []
    if not isinstance(raw_items, list) or len(raw_items) < 4:
        errors.append("remote gate requires raw GitHub payload provenance")
        return {}, {}
    payloads: dict[str, Any] = {}
    metadata: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            errors.append(f"remote provenance[{index}] invalid")
            continue
        label = text(item.get("label"), f"remote provenance[{index}].label", errors, 3)
        if label in metadata:
            errors.append(f"duplicate remote provenance label: {label}")
            continue
        path = resolve(evidence_dir, str(item.get("path", "")))
        if not is_nonempty(path):
            errors.append(f"remote provenance[{index}] file missing")
            continue
        if item.get("sha256") != sha256_file(path):
            errors.append(f"remote provenance[{index}] hash mismatch")
        text(item.get("endpoint"), f"remote provenance[{index}].endpoint", errors, 5)
        retrieved = text(item.get("retrieved_at"), f"remote provenance[{index}].retrieved_at", errors, 10)
        if retrieved:
            try:
                datetime.fromisoformat(retrieved.replace("Z", "+00:00"))
            except ValueError:
                errors.append(f"remote provenance[{index}].retrieved_at is not ISO-8601")
        metadata[label] = item
        if path.suffix.lower() == ".json":
            try:
                payloads[label] = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                errors.append(f"remote provenance[{index}] invalid JSON: {exc}")
    return payloads, metadata


def _pages(payloads: dict[str, Any], prefix: str, list_key: str | None) -> list[Any]:
    values: list[Any] = []
    page_labels = sorted(
        (label for label in payloads if label.startswith(prefix + "-page-")),
        key=lambda label: int(label.rsplit("-", 1)[1]),
    )
    for label in page_labels:
        payload = payloads[label]
        page_values = payload if list_key is None else payload.get(list_key, []) if isinstance(payload, dict) else []
        if isinstance(page_values, list):
            values.extend(page_values)
    return values


def _validate_endpoint(item: dict[str, Any] | None, expected_path: str, errors: list[str], label: str) -> None:
    if not isinstance(item, dict):
        errors.append(f"remote raw payload missing: {label}")
        return
    endpoint = str(item.get("endpoint") or "")
    parsed = urlsplit(endpoint)
    if parsed.path != expected_path:
        errors.append(f"remote raw endpoint mismatch for {label}: {endpoint}")


def _validate_jobs(jobs: list[Any], rel: str, errors: list[str]) -> None:
    if not jobs:
        errors.append(f"workflow jobs are empty: {rel}")
        return
    for job in jobs:
        if not isinstance(job, dict):
            errors.append(f"workflow job invalid: {rel}")
            continue
        if job.get("status") != "completed" or job.get("conclusion") not in ALLOWED_JOB_CONCLUSIONS:
            errors.append(f"workflow job did not complete successfully: {rel}/{job.get('name')}")
        steps = job.get("steps") or []
        if not isinstance(steps, list) or not steps:
            errors.append(f"workflow job steps are empty: {rel}/{job.get('name')}")
            continue
        for step in steps:
            if not isinstance(step, dict) or step.get("status") != "completed" or step.get("conclusion") not in ALLOWED_JOB_CONCLUSIONS:
                errors.append(f"workflow step did not complete successfully: {rel}/{job.get('name')}/{getattr(step, 'get', lambda *_: '')('name')}")


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


def validate_remote(
    data: dict[str, Any],
    repo: Path,
    evidence_dir: Path,
    metadata: dict,
    risk: dict,
    errors: list[str],
    *,
    allow_fixture: bool = False,
) -> dict:
    ref = data.get("remote_gate")
    if not isinstance(ref, dict):
        errors.append("remote_gate reference missing")
        return {}
    path = resolve(evidence_dir, str(ref.get("snapshot_path", "")))
    snapshot = load_json(path, "remote gate", errors)
    if snapshot and ref.get("snapshot_sha256") != sha256_file(path):
        errors.append("remote gate snapshot hash mismatch")
    if snapshot.get("schema_version") != 4:
        errors.append("remote gate schema_version must be 4")
    if snapshot.get("provider") != "github":
        errors.append("remote gate provider must be github")
    allowed_sources = {"gh-api", "github-rest-api"} | ({"fixture"} if allow_fixture else set())
    if snapshot.get("source") not in allowed_sources:
        errors.append("remote gate must be collected from GitHub; fixture/manual sources are invalid for a real gate")
    provenance = snapshot.get("provenance") or {}
    if provenance.get("collector") != "collect_remote_gate.py" or provenance.get("collector_version") != 4:
        errors.append("remote gate collector provenance missing or unsupported")
    collector_path = Path(__file__).resolve().parents[1] / "collect_remote_gate.py"
    if collector_path.is_file() and provenance.get("collector_sha256") != sha256_file(collector_path):
        errors.append("remote gate was produced by a different or unverified collector version")
    payloads, raw_meta = _load_raw_payloads(provenance, evidence_dir, errors)

    repository = str(data.get("repository") or "")
    pr_number = ref.get("pull_request")
    pr_path = f"/repos/{repository}/pulls/{pr_number}"
    _validate_endpoint(raw_meta.get("pr-before"), pr_path, errors, "pr-before")
    _validate_endpoint(raw_meta.get("pr-after"), pr_path, errors, "pr-after")
    for label, item in raw_meta.items():
        endpoint = str(item.get("endpoint") or "")
        parsed = urlsplit(endpoint)
        if label.startswith("workflow-runs-"):
            if parsed.path != f"/repos/{repository}/actions/runs" or parse_qs(parsed.query).get("head_sha") != [str(data.get("head_sha"))]:
                errors.append(f"workflow runs endpoint is not scoped to final SHA: {label}")
        elif label.startswith("pr-comments-page-"):
            if parsed.path != f"/repos/{repository}/issues/{pr_number}/comments":
                errors.append(f"PR comments endpoint mismatch: {label}")
        else:
            jobs_match = re.fullmatch(r"run-(\d+)-jobs-page-\d+", label)
            artifacts_match = re.fullmatch(r"run-(\d+)-artifacts-page-\d+", label)
            archive_match = re.fullmatch(r"artifact-(\d+)-archive", label)
            if jobs_match and parsed.path != f"/repos/{repository}/actions/runs/{jobs_match.group(1)}/jobs":
                errors.append(f"workflow jobs endpoint mismatch: {label}")
            elif artifacts_match and parsed.path != f"/repos/{repository}/actions/runs/{artifacts_match.group(1)}/artifacts":
                errors.append(f"workflow artifacts endpoint mismatch: {label}")
            elif archive_match and parsed.path != f"/repos/{repository}/actions/artifacts/{archive_match.group(1)}/zip":
                errors.append(f"artifact archive endpoint mismatch: {label}")

    # Snapshot fields must be reproducible from raw PR payloads.
    pr_before_raw = payloads.get("pr-before") if isinstance(payloads.get("pr-before"), dict) else {}
    pr_after_raw = payloads.get("pr-after") if isinstance(payloads.get("pr-after"), dict) else {}
    derived_before = _pr_snapshot(pr_before_raw)
    derived_after = _pr_snapshot(pr_after_raw)
    if snapshot.get("pr", {}).get("before") != derived_before:
        errors.append("remote PR before observation is not derived from raw payload")
    if snapshot.get("pr", {}).get("after") != derived_after:
        errors.append("remote PR after observation is not derived from raw payload")

    if snapshot.get("repository") != data.get("repository"):
        errors.append("remote repository differs from evidence")
    if snapshot.get("pull_request") != pr_number:
        errors.append("remote pull request differs from evidence")
    if normalize_ref(snapshot.get("base_ref"), repo) != normalize_ref(data.get("base_ref"), repo):
        errors.append("remote base_ref differs from evidence")
    head = data.get("head_sha")
    if snapshot.get("head_sha") != head or snapshot.get("head_sha_after") != head:
        errors.append("remote head changed or differs from frozen SHA")
    if snapshot.get("base_sha") != snapshot.get("base_sha_after"):
        errors.append("remote base SHA changed during collection")
    if metadata and snapshot.get("base_sha") != metadata.get("base_sha"):
        errors.append("remote base SHA differs from packet base SHA")
    if snapshot.get("merge_preview_sha") != snapshot.get("merge_preview_sha_after"):
        errors.append("merge preview changed during collection")
    for field, derived in (
        ("head_sha_after", derived_after.get("head_sha")),
        ("base_sha", derived_before.get("base_sha")),
        ("base_sha_after", derived_after.get("base_sha")),
        ("merge_preview_sha", derived_before.get("merge_preview_sha")),
        ("merge_preview_sha_after", derived_after.get("merge_preview_sha")),
    ):
        if snapshot.get(field) != derived:
            errors.append(f"remote {field} is not derived from raw PR payload")

    for phase, item in (("before", derived_before), ("after", derived_after)):
        if item.get("state") != "open":
            errors.append(f"PR must be open in remote {phase} observation")
        if item.get("merged") is not False:
            errors.append(f"PR must not be merged in remote {phase} observation")
        if item.get("head_sha") != head:
            errors.append(f"PR head mismatch in remote {phase} observation")
        if item.get("base_sha") != metadata.get("base_sha"):
            errors.append(f"PR base SHA mismatch in remote {phase} observation")
        if normalize_ref(item.get("base_ref"), repo) != normalize_ref(data.get("base_ref"), repo):
            errors.append(f"PR base ref mismatch in remote {phase} observation")
        if not isinstance(item.get("mergeable"), bool):
            errors.append(f"PR mergeability unresolved in remote {phase} observation")
        if item.get("mergeable") is False or item.get("mergeable_state") in {"dirty", "blocked"}:
            errors.append(f"PR is not mergeable in remote {phase} observation")
        if not isinstance(item.get("merge_preview_sha"), str) or len(item.get("merge_preview_sha", "")) < 7:
            errors.append(f"PR merge preview SHA missing in remote {phase} observation")

    if snapshot.get("source") != "fixture":
        try:
            observed = datetime.fromisoformat(str(snapshot.get("observed_at")).replace("Z", "+00:00"))
            age = datetime.now(timezone.utc) - observed.astimezone(timezone.utc)
            if age.total_seconds() < -60 or age.total_seconds() > 3600:
                errors.append("remote snapshot is stale or from the future")
        except Exception:
            errors.append("remote observed_at is invalid")

    runs_before = _pages(payloads, "workflow-runs-before", "workflow_runs")
    runs_after = _pages(payloads, "workflow-runs-after", "workflow_runs")
    before_by_id = {run.get("id"): run for run in runs_before if isinstance(run, dict)}
    after_by_id = {run.get("id"): run for run in runs_after if isinstance(run, dict)}

    workflow_dir = repo / ".github" / "workflows"
    expected_paths = sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")]) if workflow_dir.is_dir() else []
    expected = {path.relative_to(repo).as_posix(): path for path in expected_paths}
    items = snapshot.get("workflows") or []
    if not isinstance(items, list):
        errors.append("remote workflows must be list")
        items = []
    by_path: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append(f"remote workflow[{index}] invalid")
            continue
        rel = str(item.get("path") or "")
        if rel in by_path:
            errors.append(f"duplicate remote workflow: {rel}")
        by_path[rel] = item
    if set(by_path) != set(expected):
        errors.append(f"remote workflow inventory differs; missing={sorted(set(expected)-set(by_path))}, extra={sorted(set(by_path)-set(expected))}")

    applicable_count = 0
    successful_run_ids: set[int] = set()
    changed_files = snapshot.get("changed_files") or []
    try:
        local_changed = git(repo, "diff", "--name-only", f"{metadata.get('base_sha')}...{head}").splitlines()
    except RuntimeError as exc:
        errors.append(f"cannot derive changed files from frozen base/head: {exc}")
        local_changed = []
    if changed_files != local_changed:
        errors.append("remote changed_files differs from local frozen diff")
    for rel, workflow_path in expected.items():
        item = by_path.get(rel)
        if not item:
            continue
        try:
            definition = load_workflow(workflow_path)
            applicable, rationale, applicability, allowed_events = workflow_applicability(
                definition, changed_files, str(data.get("base_ref") or "")
            )
        except WorkflowParseError as exc:
            errors.append(str(exc))
            continue
        if any(
            isinstance(event, dict) and event.get("invalid")
            for event in (applicability.get("events") or {}).values()
        ):
            errors.append(f"workflow contains invalid PR filters: {rel}")
        if item.get("sha256") != sha256_file(workflow_path):
            errors.append(f"workflow hash mismatch: {rel}")
        if item.get("triggers_pull_request") is not bool((applicability.get("events") or {})):
            errors.append(f"workflow trigger detection mismatch: {rel}")
        if set(item.get("allowed_events") or []) != allowed_events:
            errors.append(f"workflow allowed event set mismatch: {rel}")
        if item.get("applicable") is not applicable:
            errors.append(f"workflow applicability mismatch: {rel}")
        if item.get("rationale") != rationale:
            errors.append(f"workflow rationale is not derived from YAML: {rel}")
        evidence_file = resolve(evidence_dir, str(item.get("applicability_evidence", "")))
        if not is_nonempty(evidence_file):
            errors.append(f"workflow applicability evidence missing: {rel}")
        else:
            try:
                if json.loads(evidence_file.read_text(encoding="utf-8")) != applicability:
                    errors.append(f"workflow applicability evidence differs from YAML-derived result: {rel}")
            except Exception:
                errors.append(f"workflow applicability evidence invalid: {rel}")
        if not applicable:
            continue
        applicable_count += 1
        run = item.get("run")
        if not isinstance(run, dict):
            errors.append(f"applicable workflow run missing: {rel}")
            continue
        run_id = run.get("id")
        selected = before_by_id.get(run_id)
        after_selected = after_by_id.get(run_id)
        latest_before = _latest_run(runs_before, rel, str(head), allowed_events)
        latest_after = _latest_run(runs_after, rel, str(head), allowed_events)
        if not isinstance(run_id, int) or run_id <= 0 or not isinstance(selected, dict):
            errors.append(f"workflow run id invalid or absent from raw payload: {rel}")
            continue
        if not isinstance(latest_before, dict) or latest_before.get("id") != run_id:
            errors.append(f"selected workflow run is not the latest eligible run before collection: {rel}")
        if not isinstance(latest_after, dict) or latest_after.get("id") != run_id:
            errors.append(f"a newer or replacement workflow run appeared during collection: {rel}")
        successful_run_ids.add(run_id)
        if _run_path(selected) != rel:
            errors.append(f"workflow run path mismatch: {rel}")
        if selected.get("event") not in allowed_events or run.get("event") != selected.get("event"):
            errors.append(f"workflow run event is not an allowed PR event: {rel}")
        if selected.get("head_sha") != head or run.get("head_sha") != head:
            errors.append(f"workflow run SHA mismatch: {rel}")
        if selected.get("status") != "completed" or selected.get("conclusion") != "success":
            errors.append(f"workflow did not complete successfully: {rel}")
        if not isinstance(after_selected, dict) or any(
            after_selected.get(key) != selected.get(key)
            for key in ("head_sha", "status", "conclusion", "event")
        ):
            errors.append(f"workflow run changed or disappeared during collection: {rel}")
        jobs_prefix = f"run-{run_id}-jobs"
        if not any(label.startswith(jobs_prefix + "-page-") for label in raw_meta):
            errors.append(f"workflow jobs raw payload is missing: {rel}")
        jobs = _pages(payloads, jobs_prefix, "jobs")
        _validate_jobs(jobs, rel, errors)
        if run.get("jobs_checked") is not True or run.get("steps_checked") is not True or run.get("job_count") != len(jobs):
            errors.append(f"workflow jobs/steps attestation mismatch: {rel}")
        output = resolve(evidence_dir, str(run.get("output_path", "")))
        if not is_nonempty(output):
            errors.append(f"workflow run output missing: {rel}")
        elif run.get("payload_sha256") != sha256_file(output):
            errors.append(f"workflow run output hash mismatch: {rel}")
        else:
            summary = load_json(output, f"workflow run summary {rel}", errors)
            if summary.get("run") != selected or (summary.get("jobs") or {}).get("jobs") != jobs:
                errors.append(f"workflow run summary is not derived from raw payloads: {rel}")

    derived_selected_after = {
        run_id: {
            "status": after_by_id[run_id].get("status"),
            "conclusion": after_by_id[run_id].get("conclusion"),
            "event": after_by_id[run_id].get("event"),
            "head_sha": after_by_id[run_id].get("head_sha"),
        }
        for run_id in successful_run_ids
        if run_id in after_by_id
    }
    if snapshot.get("selected_runs_after") != derived_selected_after:
        errors.append("selected_runs_after is not derived from the final raw workflow-runs payload")

    no_applicable = snapshot.get("no_applicable_pr_workflows") is True
    if applicable_count == 0:
        if not no_applicable:
            errors.append("no applicable PR workflows must be explicitly attested")
        no_evidence = resolve(evidence_dir, str(snapshot.get("no_applicable_evidence", "")))
        if not is_nonempty(no_evidence):
            errors.append("no-applicable-workflows evidence missing")
    elif no_applicable:
        errors.append("no_applicable_pr_workflows contradicts applicable workflow inventory")

    artifact_runs = snapshot.get("artifact_runs") or []
    if not isinstance(artifact_runs, list):
        errors.append("remote artifact_runs must be list")
        artifact_runs = []
    expected_successful_run_ids = {
        int(run.get("id"))
        for run in runs_before
        if isinstance(run, dict)
        and isinstance(run.get("id"), int)
        and run.get("head_sha") == head
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
    }
    approved_artifact_run_ids: set[int] = set()
    raw_artifacts_by_id: dict[int, dict[str, Any]] = {}
    for index, run in enumerate(artifact_runs):
        if not isinstance(run, dict):
            errors.append(f"remote artifact_run[{index}] invalid")
            continue
        run_id = run.get("id")
        raw_run = before_by_id.get(run_id)
        after_run = after_by_id.get(run_id)
        if not isinstance(run_id, int) or not isinstance(raw_run, dict):
            errors.append(f"remote artifact_run[{index}] absent from raw run payload")
            continue
        if not isinstance(after_run, dict) or any(
            after_run.get(key) != raw_run.get(key)
            for key in ("head_sha", "status", "conclusion", "event")
        ):
            errors.append(f"remote artifact_run[{index}] changed or disappeared during collection")
        if run.get("head_sha") != head or run.get("status") != "completed" or run.get("conclusion") != "success":
            errors.append(f"remote artifact_run[{index}] is not successful for final SHA")
        for key in ("event", "head_sha", "status", "conclusion"):
            if run.get(key) != raw_run.get(key):
                errors.append(f"remote artifact_run[{index}] {key} differs from raw run")
        output = resolve(evidence_dir, str(run.get("output_path", "")))
        if not is_nonempty(output) or run.get("payload_sha256") != sha256_file(output):
            errors.append(f"remote artifact_run[{index}] metadata missing or hash mismatch")
        else:
            try:
                if json.loads(output.read_text(encoding="utf-8")) != raw_run:
                    errors.append(f"remote artifact_run[{index}] metadata is not raw run data")
            except Exception:
                errors.append(f"remote artifact_run[{index}] metadata invalid")
        approved_artifact_run_ids.add(run_id)
        artifacts_prefix = f"run-{run_id}-artifacts"
        if not any(label.startswith(artifacts_prefix + "-page-") for label in raw_meta):
            errors.append(f"artifact list raw payload is missing for run {run_id}")
        for raw_artifact in _pages(payloads, artifacts_prefix, "artifacts"):
            if isinstance(raw_artifact, dict) and isinstance(raw_artifact.get("id"), int):
                raw_artifacts_by_id[int(raw_artifact["id"])] = raw_artifact
    if approved_artifact_run_ids != expected_successful_run_ids:
        errors.append(
            "remote artifact run inventory differs from successful final-SHA runs: "
            f"missing={sorted(expected_successful_run_ids-approved_artifact_run_ids)}, "
            f"extra={sorted(approved_artifact_run_ids-expected_successful_run_ids)}"
        )

    artifacts = snapshot.get("artifacts") or []
    if not isinstance(artifacts, list):
        errors.append("remote artifacts must be list")
        artifacts = []
    snapshot_artifact_ids = {
        int(item.get("id")) for item in artifacts
        if isinstance(item, dict) and isinstance(item.get("id"), int)
    }
    expected_artifact_ids = {
        artifact_id for artifact_id, item in raw_artifacts_by_id.items()
        if isinstance(item.get("digest"), str) and str(item.get("digest")).startswith("sha256:")
    }
    if snapshot_artifact_ids != expected_artifact_ids:
        errors.append(
            "remote artifact inventory is not derived from raw artifact pages: "
            f"missing={sorted(expected_artifact_ids-snapshot_artifact_ids)}, "
            f"extra={sorted(snapshot_artifact_ids-expected_artifact_ids)}"
        )
    kinds: set[str] = set()
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            errors.append(f"remote artifact[{index}] invalid")
            continue
        artifact_id = artifact.get("id")
        raw_artifact = raw_artifacts_by_id.get(artifact_id) if isinstance(artifact_id, int) else None
        if not isinstance(raw_artifact, dict):
            errors.append(f"remote artifact[{index}] absent from raw artifact pages")
            continue
        if artifact.get("run_id") not in approved_artifact_run_ids:
            errors.append(f"remote artifact[{index}] is not tied to a successful run for final SHA")
        if raw_artifact.get("workflow_run", {}).get("id") not in {None, artifact.get("run_id")}:
            errors.append(f"remote artifact[{index}] raw workflow run differs")
        if artifact.get("head_sha") != head:
            errors.append(f"remote artifact[{index}] SHA mismatch")
        for key in ("id", "name", "digest", "expired", "size_in_bytes", "created_at", "updated_at"):
            if artifact.get(key) != raw_artifact.get(key):
                errors.append(f"remote artifact[{index}] {key} differs from raw artifact metadata")
        if raw_artifact.get("expired") is True:
            errors.append(f"remote artifact[{index}] is expired")
        digest = artifact.get("digest")
        if not isinstance(digest, str) or not digest.startswith("sha256:"):
            errors.append(f"remote artifact[{index}] requires GitHub sha256 digest")
        output = resolve(evidence_dir, str(artifact.get("output_path", "")))
        if not is_nonempty(output) or artifact.get("payload_sha256") != sha256_file(output):
            errors.append(f"remote artifact[{index}] metadata missing or hash mismatch")
        else:
            try:
                if json.loads(output.read_text(encoding="utf-8")) != raw_artifact:
                    errors.append(f"remote artifact[{index}] metadata is not derived from raw artifact page")
            except Exception:
                errors.append(f"remote artifact[{index}] metadata invalid")
        archive = resolve(evidence_dir, str(artifact.get("archive_path", "")))
        archive_meta = raw_meta.get(f"artifact-{artifact_id}-archive")
        _validate_endpoint(
            archive_meta,
            f"/repos/{repository}/actions/artifacts/{artifact_id}/zip",
            errors,
            f"artifact-{artifact_id}-archive",
        )
        recomputed = {
            "verified": False,
            "kind": "other",
            "error": "archive unavailable",
            "checks": [],
            "results": [],
        }
        if not is_nonempty(archive) or artifact.get("archive_sha256") != sha256_file(archive):
            errors.append(f"remote artifact[{index}] archive missing or hash mismatch")
        else:
            recomputed = verify_artifact_archive(
                archive,
                artifact_id=artifact_id,
                run_id=int(artifact.get("run_id")),
                head_sha=str(head),
            )
        if artifact.get("attestation") != recomputed:
            errors.append(f"remote artifact[{index}] attestation is not derived from archive contents")
        if artifact.get("kind_verified") is not (recomputed.get("verified") is True):
            errors.append(f"remote artifact[{index}] kind_verified differs from archive verification")
        if artifact.get("kind") != recomputed.get("kind"):
            errors.append(f"remote artifact[{index}] kind differs from archive verification")
        if recomputed.get("verified") is True:
            kinds.add(str(recomputed.get("kind")))
    missing_kinds = sorted(required_artifact_kinds(risk) - kinds)
    if missing_kinds:
        errors.append(f"required remote artifact kinds missing: {missing_kinds}")

    # Handoff must be reproducible from raw PR body/comments.
    expected_handoff = None
    issue = str(data.get("issue"))
    body = str(pr_before_raw.get("body") or "")
    if handoff_matches(body, int(data.get("issue")), str(head)):
        expected_handoff = {"issue": data.get("issue"), "head_sha": head, "location": "pull-request-body", "url": pr_before_raw.get("html_url", "")}
    if not any(label.startswith("pr-comments-page-") for label in raw_meta):
        errors.append("PR comments raw payload is missing")
    comments = _pages(payloads, "pr-comments", None)
    if expected_handoff is None:
        for comment in reversed(comments):
            if not isinstance(comment, dict):
                continue
            content = str(comment.get("body") or "")
            if handoff_matches(content, int(data.get("issue")), str(head)):
                expected_handoff = {"issue": data.get("issue"), "head_sha": head, "location": "pull-request-comment", "url": comment.get("html_url", "")}
                break
    if snapshot.get("issue_handoff") != (expected_handoff or {"issue": data.get("issue"), "head_sha": "", "location": "", "url": ""}):
        errors.append("traceable issue handoff is not derived from raw PR data")
    handoff = snapshot.get("issue_handoff") or {}
    if handoff.get("issue") != data.get("issue") or handoff.get("head_sha") != head:
        errors.append("traceable issue handoff missing for final SHA")
    text(handoff.get("url"), "remote issue handoff URL", errors, 8)
    return snapshot
