from __future__ import annotations

import fnmatch
import re
from pathlib import Path, PurePosixPath
from typing import Any

import yaml


class WorkflowParseError(ValueError):
    pass


class _Yaml12Loader(yaml.SafeLoader):
    pass


_Yaml12Loader.yaml_implicit_resolvers = {
    key: list(value) for key, value in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
for key, resolvers in list(_Yaml12Loader.yaml_implicit_resolvers.items()):
    _Yaml12Loader.yaml_implicit_resolvers[key] = [
        item for item in resolvers if item[0] != "tag:yaml.org,2002:bool"
    ]
_Yaml12Loader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|false|True|False|TRUE|FALSE)$"),
    list("tTfF"),
)

PR_EVENTS = {"pull_request", "pull_request_target"}


def load_workflow_text(text: str, source: str = "<workflow>") -> dict[str, Any]:
    try:
        value = yaml.load(text, Loader=_Yaml12Loader)
    except yaml.YAMLError as exc:
        raise WorkflowParseError(f"invalid workflow YAML in {source}: {exc}") from exc
    if not isinstance(value, dict):
        raise WorkflowParseError(f"workflow YAML must be a mapping: {source}")
    return value


def load_workflow(path: Path) -> dict[str, Any]:
    return load_workflow_text(path.read_text(encoding="utf-8", errors="strict"), path.as_posix())


def _on_value(workflow: dict[str, Any]) -> Any:
    if "on" in workflow:
        return workflow["on"]
    return workflow.get(True)


def pull_request_configs(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    on_value = _on_value(workflow)
    if isinstance(on_value, str):
        return {on_value: {}} if on_value in PR_EVENTS else {}
    if isinstance(on_value, list):
        return {str(item): {} for item in on_value if str(item) in PR_EVENTS}
    if not isinstance(on_value, dict):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for event in PR_EVENTS:
        if event not in on_value:
            continue
        config = on_value[event]
        if config is None:
            result[event] = {}
        elif isinstance(config, dict):
            result[event] = config
        else:
            raise WorkflowParseError(f"on.{event} must be a mapping or null")
    return result


def workflow_triggers_pr(workflow: dict[str, Any]) -> bool:
    return bool(pull_request_configs(workflow))


def _as_patterns(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(item) for item in value if isinstance(item, str) and item.strip()]
    return []


def _github_glob_match(path: str, pattern: str) -> bool:
    normalized_path = path.replace("\\", "/").lstrip("./")
    normalized_pattern = pattern.replace("\\", "/").lstrip("/")
    if not normalized_pattern:
        return False
    return PurePosixPath(normalized_path).match(normalized_pattern) or fnmatch.fnmatchcase(
        normalized_path, normalized_pattern
    )


def _ordered_match(value: str, patterns: list[str]) -> bool:
    included = False
    for raw in patterns:
        negative = raw.startswith("!")
        pattern = raw[1:] if negative else raw
        if _github_glob_match(value, pattern):
            included = not negative
    return included


def event_applicable(
    config: dict[str, Any], changed_files: list[str], base_ref: str
) -> tuple[bool, dict[str, Any]]:
    paths = _as_patterns(config.get("paths"))
    paths_ignore = _as_patterns(config.get("paths-ignore"))
    branches = _as_patterns(config.get("branches"))
    branches_ignore = _as_patterns(config.get("branches-ignore"))
    evidence: dict[str, Any] = {
        "changed_files": list(changed_files),
        "base_ref": base_ref,
        "paths": paths,
        "paths_ignore": paths_ignore,
        "branches": branches,
        "branches_ignore": branches_ignore,
    }
    invalid: list[str] = []
    if paths and paths_ignore:
        invalid.append("paths and paths-ignore cannot be used together")
    if branches and branches_ignore:
        invalid.append("branches and branches-ignore cannot be used together")
    if invalid:
        evidence["invalid"] = invalid
        return False, evidence

    branch_applicable = True
    if branches:
        branch_applicable = _ordered_match(base_ref, branches)
    elif branches_ignore:
        branch_applicable = not any(_github_glob_match(base_ref, pattern) for pattern in branches_ignore)
    evidence["branch_applicable"] = branch_applicable
    if not branch_applicable:
        return False, evidence

    if paths:
        matched = [path for path in changed_files if _ordered_match(path, paths)]
        evidence["matched"] = matched
        return bool(matched), evidence
    if paths_ignore:
        remaining = [
            path
            for path in changed_files
            if not any(_github_glob_match(path, pattern) for pattern in paths_ignore)
        ]
        evidence["remaining"] = remaining
        return bool(remaining), evidence
    return True, evidence


def workflow_applicability(
    workflow: dict[str, Any], changed_files: list[str], base_ref: str = ""
) -> tuple[bool, str, dict[str, Any], set[str]]:
    configs = pull_request_configs(workflow)
    if not configs:
        return False, "workflow does not trigger pull_request or pull_request_target", {
            "changed_files": changed_files,
            "base_ref": base_ref,
            "events": {},
        }, set()
    events: dict[str, Any] = {}
    applicable_events: set[str] = set()
    invalid_events: list[str] = []
    for event, config in configs.items():
        applicable, evidence = event_applicable(config, changed_files, base_ref)
        events[event] = {"applicable": applicable, **evidence}
        if evidence.get("invalid"):
            invalid_events.append(event)
        elif applicable:
            applicable_events.add(event)
    applicable = bool(applicable_events)
    if invalid_events:
        rationale = "invalid PR workflow filters: " + ", ".join(sorted(invalid_events))
    elif applicable:
        rationale = "applicable PR events: " + ", ".join(sorted(applicable_events))
    else:
        rationale = "PR branch/path filters matched no target branch or changed files"
    return applicable, rationale, {
        "changed_files": changed_files,
        "base_ref": base_ref,
        "events": events,
    }, applicable_events
