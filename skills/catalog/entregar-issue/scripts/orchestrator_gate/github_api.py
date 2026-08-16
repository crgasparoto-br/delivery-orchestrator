from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def endpoint_filename(endpoint: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", endpoint.strip("/")) + ".json"


def _with_page(endpoint: str, page: int, per_page: int = 100) -> str:
    parsed = urllib.parse.urlsplit(endpoint)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    query["page"] = [str(page)]
    query["per_page"] = [str(per_page)]
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query, doseq=True), parsed.fragment))


class GitHubClient:
    def __init__(self, raw_dir: Path, fixture_dir: Path | None = None) -> None:
        self.raw_dir = raw_dir
        self.fixture_dir = fixture_dir
        self.token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        self.gh = subprocess.run(
            ["bash", "-lc", "command -v gh"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
        if not fixture_dir and not self.gh and not self.token:
            raise RuntimeError("GitHub access requires gh, GITHUB_TOKEN/GH_TOKEN, or --fixture-dir")

    def _write_json(self, label: str, payload: Any) -> Path:
        target = self.raw_dir / f"{label}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return target

    def get(self, endpoint: str, label: str) -> tuple[Any, dict[str, str]]:
        if self.fixture_dir:
            source = self.fixture_dir / endpoint_filename(endpoint)
            if not source.is_file():
                # Fixtures may omit page=1 while production always paginates.
                parsed = urllib.parse.urlsplit(endpoint)
                query = urllib.parse.parse_qs(parsed.query)
                if query.get("page") == ["1"]:
                    query.pop("page", None)
                    fallback = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query, doseq=True), parsed.fragment))
                    source = self.fixture_dir / endpoint_filename(fallback)
            if not source.is_file():
                raise RuntimeError(f"fixture not found for {endpoint}: {source}")
            payload = json.loads(source.read_text(encoding="utf-8"))
        elif self.gh:
            proc = subprocess.run(
                ["gh", "api", endpoint],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip() or f"gh api failed: {endpoint}")
            payload = json.loads(proc.stdout)
        else:
            request = urllib.request.Request(
                "https://api.github.com" + endpoint,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "orquestrador-skill",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    payload = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                raise RuntimeError(
                    f"GitHub API {endpoint} failed: {exc.code} {exc.read().decode('utf-8', errors='replace')}"
                ) from exc
        target = self._write_json(label, payload)
        return payload, {
            "label": label,
            "path": str(target),
            "sha256": sha256_file(target),
            "endpoint": endpoint,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def paginate(self, endpoint: str, label: str, list_key: str | None = None) -> tuple[Any, list[dict[str, str]]]:
        combined: list[Any] = []
        raw: list[dict[str, str]] = []
        page = 1
        total_count: int | None = None
        while True:
            page_endpoint = _with_page(endpoint, page)
            payload, item = self.get(page_endpoint, f"{label}-page-{page}")
            raw.append(item)
            if list_key is None:
                values = payload if isinstance(payload, list) else []
            else:
                values = payload.get(list_key, []) if isinstance(payload, dict) else []
                if isinstance(payload, dict) and isinstance(payload.get("total_count"), int):
                    total_count = payload["total_count"]
            if not isinstance(values, list):
                raise RuntimeError(f"paginated endpoint {endpoint} did not return a list")
            combined.extend(values)
            if len(values) < 100 or (total_count is not None and len(combined) >= total_count):
                break
            page += 1
            if page > 100:
                raise RuntimeError(f"pagination exceeded 100 pages for {endpoint}")
        if list_key is None:
            return combined, raw
        return {list_key: combined, "total_count": total_count if total_count is not None else len(combined)}, raw

    def download_artifact(self, repository: str, artifact_id: int, label: str) -> tuple[Path, dict[str, str]]:
        endpoint = f"/repos/{repository}/actions/artifacts/{artifact_id}/zip"
        target = self.raw_dir / f"{label}.zip"
        target.parent.mkdir(parents=True, exist_ok=True)
        if self.fixture_dir:
            source = self.fixture_dir / f"artifact-{artifact_id}.zip"
            if not source.is_file():
                raise RuntimeError(f"artifact fixture missing: {source}")
            target.write_bytes(source.read_bytes())
        elif self.gh:
            with target.open("wb") as handle:
                proc = subprocess.run(["gh", "api", endpoint], stdout=handle, stderr=subprocess.PIPE)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.decode("utf-8", errors="replace") or f"artifact download failed: {artifact_id}")
        else:
            request = urllib.request.Request(
                "https://api.github.com" + endpoint,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "orquestrador-skill",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    target.write_bytes(response.read())
            except urllib.error.HTTPError as exc:
                raise RuntimeError(f"artifact download failed: {artifact_id}: HTTP {exc.code}") from exc
        return target, {
            "label": label,
            "path": str(target),
            "sha256": sha256_file(target),
            "endpoint": endpoint,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }
