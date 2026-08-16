from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit_test_helpers import generate_keypair, sign_report, write_approved_report, write_registry
from orchestrator_gate.audit_signature import validate_registry_boundary


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(arg) for arg in args],
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ApprovedStateValidationTests(unittest.TestCase):
    def _git_repo(self, root: Path) -> tuple[Path, str]:
        repo = root / "repo"
        repo.mkdir()
        self.assertEqual(0, run("git", "init", "-b", "main", cwd=repo).returncode)
        self.assertEqual(0, run("git", "config", "user.email", "test@example.com", cwd=repo).returncode)
        self.assertEqual(0, run("git", "config", "user.name", "Test", cwd=repo).returncode)
        (repo / "app.txt").write_text("stable\n", encoding="utf-8")
        self.assertEqual(0, run("git", "add", "app.txt", cwd=repo).returncode)
        self.assertEqual(0, run("git", "commit", "-m", "initial", cwd=repo).returncode)
        head = run("git", "rev-parse", "HEAD", cwd=repo).stdout.strip()
        self.assertEqual(40, len(head))
        return repo, head

    def _build_approved_state(self, root: Path) -> tuple[Path, dict[str, Path]]:
        repo, head = self._git_repo(root)
        merge_preview = "c" * 40
        cycle = 3
        private_key = root / "auditor-private.pem"
        public_key = root / "auditor-public.pem"
        registry = root / "trusted-auditors.json"
        report = root / "audit-report.json"
        state = root / "state.json"

        generate_keypair(private_key, public_key)
        write_registry(registry, public_key)
        write_approved_report(
            report,
            repository="owner/repo",
            issue=5,
            base_ref="main",
            head_sha=head,
            base_sha=head,
            merge_preview_sha=merge_preview,
            cycle=cycle,
            implementation_context_id="implementation-context-1",
            audit_context_id="independent-audit-context-2",
        )
        sign_report(report, private_key)

        artifact_paths: dict[str, Path] = {}
        current_artifacts: dict[str, dict[str, object]] = {}
        for name, contents in {
            "packet-manifest": "packet manifest\n",
            "pass-b-plan": "pass b plan\n",
            "remote-gate": json.dumps({"schema_version": 4, "head_sha": head}) + "\n",
        }.items():
            artifact = root / f"{name}.json"
            artifact.write_text(contents, encoding="utf-8")
            artifact_paths[name] = artifact
            current_artifacts[name] = {
                "path": str(artifact),
                "sha256": sha256(artifact),
                "head_sha": head,
                "base_sha": head,
                "merge_preview_sha": merge_preview,
                "cycle": cycle,
                "registered_at": "2026-07-24T22:00:00+00:00",
            }

        state.write_text(json.dumps({
            "schema_version": 3,
            "repository": "owner/repo",
            "repository_path": str(repo),
            "issue": 5,
            "base_ref": "main",
            "branch": "main",
            "pull_request": 10,
            "state": "pronto-para-auditoria-independente",
            "cycle": cycle,
            "head_sha": head,
            "base_sha": head,
            "merge_preview_sha": merge_preview,
            "implementation_context_id": "implementation-context-1",
            "current_artifacts": current_artifacts,
            "invalidated_artifacts": [],
            "findings": [],
            "external_audit": None,
            "audit_history": [],
            "invalidated_audits": [],
            "transitions": [{
                "at": "2026-07-24T22:00:00+00:00",
                "from": "verificado",
                "to": "pronto-para-auditoria-independente",
                "reason": "gate passed",
                "head_sha": head,
                "base_sha": head,
                "merge_preview_sha": merge_preview,
            }],
            "updated_at": "2026-07-24T22:00:00+00:00",
        }), encoding="utf-8")

        proc = run(
            sys.executable,
            ROOT / "scripts/update_orchestration_state.py",
            state,
            "import-audit",
            "--report-path", report,
            "--trusted-auditors", registry,
        )
        self.assertEqual(0, proc.returncode, proc.stderr)
        return state, {
            "repo": repo,
            "report": report,
            "registry": registry,
            **artifact_paths,
        }

    def test_signed_approved_state_is_revalidated_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state, _paths = self._build_approved_state(Path(tmp))
            env = os.environ.copy()
            env["ORCHESTRATOR_TEST_MODE"] = "1"
            proc = run(
                sys.executable,
                ROOT / "scripts/validate_approved_state.py",
                state,
                "--skip-remote-recheck",
                env=env,
            )
            self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
            self.assertIn("PASS", proc.stdout)

    def test_approved_state_is_invalidated_by_artifact_or_report_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state, paths = self._build_approved_state(root)
            env = os.environ.copy()
            env["ORCHESTRATOR_TEST_MODE"] = "1"

            paths["packet-manifest"].write_text("tampered\n", encoding="utf-8")
            proc = run(
                sys.executable,
                ROOT / "scripts/validate_approved_state.py",
                state,
                "--skip-remote-recheck",
                env=env,
            )
            self.assertNotEqual(0, proc.returncode)
            self.assertIn("hash mismatch", proc.stdout)

            # Restore the artifact and then modify the signed report without updating state.
            paths["packet-manifest"].write_text("packet manifest\n", encoding="utf-8")
            paths["report"].write_text(paths["report"].read_text(encoding="utf-8") + "\n", encoding="utf-8")
            proc = run(
                sys.executable,
                ROOT / "scripts/validate_approved_state.py",
                state,
                "--skip-remote-recheck",
                env=env,
            )
            self.assertNotEqual(0, proc.returncode)
            self.assertIn("report hash differs", proc.stdout)

    def test_registry_modified_by_the_implementation_diff_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            self.assertEqual(0, run("git", "init", "-b", "main", cwd=repo).returncode)
            self.assertEqual(0, run("git", "config", "user.email", "test@example.com", cwd=repo).returncode)
            self.assertEqual(0, run("git", "config", "user.name", "Test", cwd=repo).returncode)
            registry = repo / "trusted-auditors.json"
            registry.write_text('{"schema_version":1,"auditors":[]}\n', encoding="utf-8")
            self.assertEqual(0, run("git", "add", "trusted-auditors.json", cwd=repo).returncode)
            self.assertEqual(0, run("git", "commit", "-m", "trusted registry", cwd=repo).returncode)
            base = run("git", "rev-parse", "HEAD", cwd=repo).stdout.strip()
            self.assertEqual(0, run("git", "switch", "-c", "feature", cwd=repo).returncode)
            registry.write_text('{"schema_version":1,"auditors":[{"key_id":"self"}]}\n', encoding="utf-8")
            self.assertEqual(0, run("git", "add", "trusted-auditors.json", cwd=repo).returncode)
            self.assertEqual(0, run("git", "commit", "-m", "trust implementation key", cwd=repo).returncode)
            head = run("git", "rev-parse", "HEAD", cwd=repo).stdout.strip()
            errors = validate_registry_boundary(
                registry,
                repository_path=repo,
                base_sha=base,
                head_sha=head,
            )
            self.assertTrue(any("changed by the implementation diff" in item for item in errors), errors)


if __name__ == "__main__":
    unittest.main()
