from __future__ import annotations
import json, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/controller_cli.py"

class ControllerContextTests(unittest.TestCase):
    def test_telemetry_does_not_invalidate_semantic_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            out = temp / "controller-context.json"
            subprocess.run([sys.executable, str(CLI), "init-context", "--repository", "owner/repo", "--repository-path", str(temp), "--issue", "1", "--base-ref", "main", "--branch", "issue-1", "--out", str(out)], check=True)
            initial = json.loads(out.read_text())
            self.assertEqual(initial["controller_revision"], 1)

            subprocess.run([sys.executable, str(CLI), "record-metric", "--context", str(out), "--metric", "subskill_calls"], check=True)
            after_metric = json.loads(out.read_text())
            self.assertEqual(after_metric["metrics"]["subskill_calls"], 1)
            self.assertEqual(after_metric["controller_revision"], 1)

            subprocess.run([sys.executable, str(CLI), "refresh-context", "--context", str(out), "--branch", "issue-1"], check=True)
            after_noop = json.loads(out.read_text())
            self.assertEqual(after_noop["controller_revision"], 1)

            manifest = temp / "source-manifest.json"
            manifest.write_text(json.dumps({"sources": [{"path": "README.md", "sha256": "a" * 64}]}))
            subprocess.run([sys.executable, str(CLI), "refresh-context", "--context", str(out), "--source-manifest-file", str(manifest)], check=True)
            after_refresh = json.loads(out.read_text())
            self.assertEqual(after_refresh["controller_revision"], 2)

            subprocess.run([sys.executable, str(CLI), "refresh-context", "--context", str(out), "--source-manifest-file", str(manifest)], check=True)
            after_repeated_refresh = json.loads(out.read_text())
            self.assertEqual(after_repeated_refresh["controller_revision"], 2)

            subprocess.run([sys.executable, str(CLI), "advance-cycle", "--context", str(out)], check=True)
            payload = json.loads(out.read_text())
            self.assertEqual(payload["contract_version"], "2026-08-06.2")
            self.assertEqual(payload["controller_cycle"], 2)
            self.assertEqual(payload["controller_revision"], 3)

    def test_identity_observation_does_not_increment_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            out = temp / "controller-context.json"
            subprocess.run([
                sys.executable, str(CLI), "init-context",
                "--repository", "owner/repo", "--repository-path", str(temp),
                "--issue", "2", "--base-ref", "main", "--branch", "issue-2",
                "--head-sha", "a" * 40, "--base-sha", "b" * 40,
                "--merge-preview-sha", "c" * 40, "--out", str(out),
            ], check=True)
            initial = json.loads(out.read_text())

            identity = temp / "identity.json"
            identity.write_text(json.dumps({
                "head_sha": "a" * 40,
                "base_sha": "b" * 40,
                "merge_preview_sha": "c" * 40,
                "observed_at": "2026-08-05T12:00:00Z",
            }))
            completed = subprocess.run([
                sys.executable, str(CLI), "refresh-context", "--context", str(out),
                "--identity-file", str(identity),
            ], check=True, capture_output=True, text=True)
            observed = json.loads(out.read_text())

            self.assertIn("context-observed", completed.stdout)
            self.assertEqual(observed["controller_revision"], initial["controller_revision"])
            self.assertEqual(observed["identity"]["captured_at"], initial["identity"]["captured_at"])
            self.assertEqual(observed["identity"]["observed_at"], "2026-08-05T12:00:00Z")

    def test_refresh_can_batch_metrics_without_semantic_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            out = temp / "controller-context.json"
            subprocess.run([
                sys.executable, str(CLI), "init-context",
                "--repository", "owner/repo", "--repository-path", str(temp),
                "--issue", "3", "--base-ref", "main", "--branch", "issue-3",
                "--out", str(out),
            ], check=True)
            subprocess.run([
                sys.executable, str(CLI), "refresh-context", "--context", str(out),
                "--metric", "subskill_calls=2", "--metric", "reused_stages=3",
            ], check=True)
            payload = json.loads(out.read_text())
            self.assertEqual(payload["controller_revision"], 1)
            self.assertEqual(payload["metrics"]["subskill_calls"], 2)
            self.assertEqual(payload["metrics"]["reused_stages"], 3)

if __name__ == "__main__":
    unittest.main()
