from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def endpoint_filename(endpoint: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", endpoint.strip("/")) + ".json"


class CollectRemoteGateTests(unittest.TestCase):
    def test_collector_attests_no_applicable_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / ".github/workflows").mkdir(parents=True)
            (repo / ".github/workflows/manual.yml").write_text("name: Manual\non: push\njobs: {}\n", encoding="utf-8")
            (repo / "file.txt").write_text("x", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            fixtures = root / "fixtures"
            fixtures.mkdir()
            pr_endpoint = "/repos/owner/repo/pulls/10"
            pr = {
                "state": "open", "draft": False, "merged": False, "mergeable": True,
                "mergeable_state": "clean", "merge_commit_sha": "merge123",
                "head": {"sha": head}, "base": {"ref": "main", "sha": head},
                "body": f"Issue 5 handoff SHA {head}", "html_url": "https://example.test/pr/10",
            }
            (fixtures / endpoint_filename(pr_endpoint)).write_text(json.dumps(pr), encoding="utf-8")
            runs_endpoint = f"/repos/owner/repo/actions/runs?head_sha={head}&per_page=100"
            (fixtures / endpoint_filename(runs_endpoint)).write_text(json.dumps({"workflow_runs": []}), encoding="utf-8")
            comments_endpoint = "/repos/owner/repo/issues/10/comments?per_page=100"
            (fixtures / endpoint_filename(comments_endpoint)).write_text("[]", encoding="utf-8")
            out = root / "remote.json"
            subprocess.run([
                sys.executable, str(ROOT / "scripts/collect_remote_gate.py"),
                "--repo", str(repo), "--repository", "owner/repo", "--pull-request", "10",
                "--base-ref", "main", "--head-sha", head, "--issue", "5",
                "--fixture-dir", str(fixtures), "--out", str(out),
            ], check=True, stdout=subprocess.PIPE, text=True)
            snapshot = json.loads(out.read_text(encoding="utf-8"))
            self.assertTrue(snapshot["no_applicable_pr_workflows"])
            self.assertEqual("collect_remote_gate.py", snapshot["provenance"]["collector"])
            self.assertEqual(head, snapshot["head_sha_after"])
            self.assertEqual(head, snapshot["base_sha_after"])


if __name__ == "__main__":
    unittest.main()
