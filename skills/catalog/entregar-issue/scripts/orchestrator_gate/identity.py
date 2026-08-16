from __future__ import annotations

import re


def mentions_issue(value: str, issue: int) -> bool:
    """Require an explicit issue token, never a bare numeric substring."""
    text = str(value or "")
    number = re.escape(str(issue))
    pattern = re.compile(
        rf"(?ix)(?:\bissue\s*\#?\s*{number}(?!\d)|(?<![A-Za-z0-9_])\#{number}(?!\d))"
    )
    return bool(pattern.search(text))


def mentions_sha(value: str, sha: str) -> bool:
    text = str(value or "")
    token = re.escape(str(sha or ""))
    if not token:
        return False
    return bool(re.search(rf"(?i)(?<![0-9a-f]){token}(?![0-9a-f])", text))


def mentions_repository(value: str, repository: str) -> bool:
    text = str(value or "")
    token = re.escape(str(repository or ""))
    if not token:
        return False
    return bool(re.search(rf"(?<![A-Za-z0-9_.-]){token}(?![A-Za-z0-9_.-])", text))


def handoff_matches(value: str, issue: int, sha: str) -> bool:
    return mentions_issue(value, issue) and mentions_sha(value, sha)


def audit_command_matches(value: str, repository: str, issue: int, sha: str) -> bool:
    return (
        mentions_repository(value, repository)
        and mentions_issue(value, issue)
        and mentions_sha(value, sha)
    )
