from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.github_api import endpoint_filename
from orchestrator_gate.remote_validation import validate_remote


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_fixture(directory: Path, endpoint: str, value) -> None:
    (directory / endpoint_filename(endpoint)).write_text(json.dumps(value), encoding="utf-8")


class RemoteValidationTests(unittest.TestCase):
    def make_repo(self, root: Path) -> tuple[Path, str]:
        repo = root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
        (repo / ".github/workflows").mkdir(parents=True)
        (repo / ".github/workflows/manual.yml").write_text("name: manual\non: push\njobs: {}\n", encoding="utf-8")
        (repo / "file.txt").write_text("x", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True)
        subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        return repo, head

    def collect(self, base: Path, repo: Path, head: str) -> Path:
        fixtures = base / "fixtures"
        fixtures.mkdir()
        pr_endpoint = "/repos/owner/repo/pulls/10"
        pr = {
            "state": "open", "draft": False, "merged": False, "mergeable": True,
            "mergeable_state": "clean", "merge_commit_sha": "merge1234",
            "head": {"sha": head}, "base": {"ref": "main", "sha": head},
            "body": f"Issue 5 handoff SHA {head}", "html_url": "https://example.test/pr/10",
        }
        write_fixture(fixtures, pr_endpoint, pr)
        write_fixture(fixtures, f"/repos/owner/repo/actions/runs?head_sha={head}&page=1&per_page=100", {"total_count": 0, "workflow_runs": []})
        write_fixture(fixtures, "/repos/owner/repo/issues/10/comments?page=1&per_page=100", [])
        remote = base / "remote.json"
        subprocess.run([
            sys.executable, str(ROOT / "scripts/collect_remote_gate.py"),
            "--repo", str(repo), "--repository", "owner/repo", "--pull-request", "10",
            "--base-ref", "main", "--head-sha", head, "--issue", "5",
            "--out", str(remote), "--fixture-dir", str(fixtures),
        ], check=True, stdout=subprocess.PIPE, text=True)
        return remote

    def test_zero_applicable_pr_workflows_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo, head = self.make_repo(base)
            remote_path = self.collect(base, repo, head)
            data = {
                "repository": "owner/repo", "issue": 5, "base_ref": "main", "head_sha": head,
                "remote_gate": {"snapshot_path": str(remote_path), "snapshot_sha256": sha(remote_path), "pull_request": 10},
            }
            errors: list[str] = []
            validate_remote(data, repo, base, {"base_sha": head}, {"documentation_impact": False}, errors, allow_fixture=True)
            self.assertEqual([], errors)

    def test_base_change_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo, head = self.make_repo(base)
            remote_path = self.collect(base, repo, head)
            snapshot = json.loads(remote_path.read_text(encoding="utf-8"))
            snapshot["base_sha_after"] = "different"
            remote_path.write_text(json.dumps(snapshot), encoding="utf-8")
            data = {
                "repository": "owner/repo", "issue": 5, "base_ref": "main", "head_sha": head,
                "remote_gate": {"snapshot_path": str(remote_path), "snapshot_sha256": sha(remote_path), "pull_request": 10},
            }
            errors: list[str] = []
            validate_remote(data, repo, base, {"base_sha": head}, {"documentation_impact": False}, errors, allow_fixture=True)
            self.assertTrue(any("base SHA changed" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
