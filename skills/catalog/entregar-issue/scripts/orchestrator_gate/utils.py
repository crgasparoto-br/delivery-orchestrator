from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_nonempty(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


def resolve(base: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (base / path).resolve()


def load_json(path: Path, label: str, errors: list[str]) -> dict[str, Any]:
    if not is_nonempty(path):
        errors.append(f"{label}: file missing or empty: {path}")
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"{label}: invalid JSON: {exc}")
        return {}
    if not isinstance(value, dict):
        errors.append(f"{label}: must be a JSON object")
        return {}
    return value


def text(value: Any, label: str, errors: list[str], minimum: int = 1) -> str:
    if not isinstance(value, str) or len(value.strip()) < minimum:
        errors.append(f"{label}: missing or insufficient text")
        return ""
    return value.strip()


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", *args], cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "git command failed")
    return proc.stdout.strip()
