#!/usr/bin/env python3
"""Reject obvious historical issue coupling in permanent skill assets."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

NUMBERED_TEST = re.compile(r"^test_issue_[0-9]+.*\.py$", re.IGNORECASE)
DERIVED_HEADING = re.compile(r"derivad[oa]s?\s+(?:da|de)\s+issue\s+#?\d+", re.IGNORECASE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill-root", required=True)
    args = parser.parse_args()
    root = Path(args.skill_root).resolve()
    errors: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts or ".pytest_cache" in path.parts:
            continue
        if NUMBERED_TEST.match(path.name):
            errors.append(f"numbered issue-specific test filename: {path.relative_to(root)}")
        if path.suffix.lower() not in {".md", ".py", ".json", ".yaml", ".yml", ".txt"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        if DERIVED_HEADING.search(text):
            errors.append(f"historical issue-derived permanent rule: {path.relative_to(root)}")
    if errors:
        for error in errors:
            print(f"BLOCK: {error}")
        return 2
    print("READY: skill permanent assets are free of obvious issue-number coupling")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
