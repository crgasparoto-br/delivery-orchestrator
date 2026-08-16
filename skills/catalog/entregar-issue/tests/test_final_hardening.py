from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit_test_helpers import generate_keypair, sign_report, write_approved_report, write_registry
from orchestrator_gate.artifact_attestation import verify_artifact_archive
from orchestrator_gate.evidence_validation import validate_evidence
from orchestrator_gate.identity import audit_command_matches, handoff_matches, mentions_issue
from orchestrator_gate.remote_recheck import live_recheck
from orchestrator_gate.workflow_rules import WorkflowParseError, load_workflow_text, workflow_applicability
from runtime_graph import build_runtime_context


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _RecheckClient:
    def __init__(self, *_args, **_kwargs):
        pass

    def get(self, endpoint: str, _label: str):
        if endpoint.endswith("/pulls/10"):
            head = "h" * 40
            return {
                "state": "open",
                "merged": False,
                "body": f"Issue 5 SHA {head}",
                "html_url": "https://example.test/pr/10",
                "merge_commit_sha": "m" * 40,
                "head": {"sha": head},
                "base": {"sha": "b" * 40, "ref": "main"},
            }, {}
        raise AssertionError(endpoint)

    def paginate(self, endpoint: str, _label: str, list_key: str | None):
        head = "h" * 40
        if "/actions/runs?head_sha=" in endpoint:
            return {
                "workflow_runs": [
                    {
                        "id": 1,
                        "path": ".github/workflows/ci.yml",
                        "event": "pull_request",
                        "head_sha": head,
                        "status": "completed",
                        "conclusion": "success",
                        "created_at": "2026-07-24T22:00:00Z",
                        "run_attempt": 1,
                    },
                    {
                        "id": 2,
                        "path": ".github/workflows/ci.yml",
                        "event": "pull_request",
                        "head_sha": head,
                        "status": "completed",
                        "conclusion": "failure",
                        "created_at": "2026-07-24T22:10:00Z",
                        "run_attempt": 2,
                    },
                ]
            }, []
        if endpoint.endswith("/actions/runs/2/jobs"):
            return {
                "jobs": [{
                    "id": 20,
                    "name": "test",
                    "status": "completed",
                    "conclusion": "failure",
                    "steps": [{"name": "tests", "status": "completed", "conclusion": "failure"}],
                }]
            }, []
        if endpoint.endswith("/actions/runs/1/artifacts"):
            return {"artifacts": []}, []
        if endpoint.endswith("/issues/10/comments"):
            return [], []
        raise AssertionError(endpoint)

    def download_artifact(self, *_args, **_kwargs):
        raise AssertionError("no artifact should be downloaded")


class FinalHardeningTests(unittest.TestCase):
    def test_collector_orders_equal_timestamp_runs_by_attempt_and_id(self) -> None:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "collect_remote_gate", ROOT / "scripts/collect_remote_gate.py"
        )
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        runs = [
            {"created_at": "2026-07-24T22:00:00Z", "run_attempt": 1, "id": 11},
            {"created_at": "2026-07-24T22:00:00Z", "run_attempt": 2, "id": 10},
            {"created_at": "2026-07-24T22:00:00Z", "run_attempt": 2, "id": 12},
        ]
        runs.sort(key=module.run_sort_key, reverse=True)
        self.assertEqual([12, 10, 11], [item["id"] for item in runs])

    def test_live_recheck_rejects_newer_failed_rerun(self) -> None:
        head = "h" * 40
        data = {
            "repository": "owner/repo",
            "issue": 5,
            "head_sha": head,
            "remote_gate": {"pull_request": 10},
        }
        snapshot = {
            "head_sha": head,
            "base_sha": "b" * 40,
            "base_ref": "main",
            "merge_preview_sha": "m" * 40,
            "workflows": [{
                "path": ".github/workflows/ci.yml",
                "applicable": True,
                "allowed_events": ["pull_request"],
                "run": {
                    "id": 1,
                    "head_sha": head,
                    "event": "pull_request",
                    "status": "completed",
                    "conclusion": "success",
                },
            }],
            "artifact_runs": [{"id": 1}],
            "artifacts": [],
            "issue_handoff": {
                "issue": 5,
                "head_sha": head,
                "location": "pull-request-body",
                "url": "https://example.test/pr/10",
            },
        }
        with patch("orchestrator_gate.remote_recheck.GitHubClient", _RecheckClient):
            errors, _ = live_recheck(data, snapshot)
        self.assertTrue(any("newer or replacement run" in item for item in errors))
        self.assertTrue(any("latest run is not successful" in item for item in errors))

    def test_direct_transition_cannot_approve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            state.write_text(json.dumps({
                "schema_version": 3,
                "state": "pronto-para-auditoria-independente",
                "head_sha": "a" * 40,
                "base_sha": "b" * 40,
                "merge_preview_sha": "c" * 40,
            }), encoding="utf-8")
            proc = subprocess.run([
                sys.executable,
                str(ROOT / "scripts/transition_orchestration_state.py"),
                str(state),
                "--to", "aprovado",
                "--reason", "self approval",
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(2, proc.returncode)
            self.assertIn("only be produced by importing", proc.stderr)
            self.assertEqual("pronto-para-auditoria-independente", json.loads(state.read_text())["state"])

    def test_bare_self_attested_artifact_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "artifact.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("orquestrador-artifact.json", json.dumps({
                    "schema_version": 2,
                    "kind": "visual",
                    "head_sha": "a" * 40,
                    "run_id": 1,
                    "artifact_id": 2,
                    "generator": "fake",
                    "generated_at": "2026-07-24T22:00:00Z",
                    "checks": ["visual validation passed"],
                    "results": [],
                }))
            result = verify_artifact_archive(archive, artifact_id=2, run_id=1, head_sha="a" * 40)
            self.assertFalse(result["verified"])
            self.assertEqual("other", result["kind"])

    def test_artifact_requires_hashed_result_and_bidirectional_links(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "artifact.zip"
            payload = b"PASS: accessibility checks\n"
            manifest = {
                "schema_version": 2,
                "kind": "visual",
                "head_sha": "a" * 40,
                "run_id": 1,
                "artifact_id": 2,
                "generator": "visual-validator/1",
                "generated_at": "2026-07-24T22:00:00Z",
                "checks": [{
                    "id": "layout-three-viewports",
                    "claim": "Layout remained usable in all required viewports.",
                    "result_paths": ["results/a11y.log"],
                }],
                "results": [{
                    "path": "results/a11y.log",
                    "sha256": digest(payload),
                    "size": len(payload),
                    "command": "node scripts/a11y.mjs",
                    "exit_code": 0,
                    "expected_exit": 0,
                    "check_ids": ["layout-three-viewports"],
                    "media_type": "text/plain",
                }],
            }
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("orquestrador-artifact.json", json.dumps(manifest))
                bundle.writestr("results/a11y.log", payload)
            result = verify_artifact_archive(archive, artifact_id=2, run_id=1, head_sha="a" * 40)
            self.assertTrue(result["verified"], result["error"])
            self.assertEqual("visual", result["kind"])

    def test_jsonc_extends_alias_is_in_runtime_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "config").mkdir()
            (repo / "src/lib").mkdir(parents=True)
            (repo / "src").mkdir(exist_ok=True)
            (repo / "config/base.jsonc").write_text('''{
              // JSONC is normal in TypeScript projects
              "compilerOptions": {
                "baseUrl": "..",
                "paths": {"@/*": ["src/*",],},
              },
            }''', encoding="utf-8")
            (repo / "tsconfig.json").write_text('{"extends":"./config/base.jsonc"}', encoding="utf-8")
            (repo / "src/main.ts").write_text('import { value } from "@/lib/value"; export { value };', encoding="utf-8")
            (repo / "src/lib/value.ts").write_text('export const value = 1;', encoding="utf-8")
            files, _, unresolved, coverage = build_runtime_context(repo, ["src/main.ts"])
            self.assertIn("src/lib/value.ts", {item["path"] for item in files})
            self.assertFalse(unresolved)
            self.assertTrue(coverage["complete"], coverage)

    def test_invalid_typescript_config_makes_graph_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "tsconfig.json").write_text('{ invalid', encoding="utf-8")
            (repo / "src/main.ts").write_text('import value from "@/value";', encoding="utf-8")
            _, _, unresolved, coverage = build_runtime_context(repo, ["src/main.ts"])
            self.assertTrue(unresolved or coverage.get("configuration_errors"))
            self.assertFalse(coverage["complete"])

    def test_malformed_workflow_is_fail_closed(self) -> None:
        with self.assertRaises(WorkflowParseError):
            load_workflow_text("on: [pull_request\n jobs: {}", "broken.yml")

    def test_branch_filters_use_pr_base_branch(self) -> None:
        workflow = load_workflow_text('''
name: CI
on:
  pull_request:
    branches: [main]
    paths: [src/**]
jobs: {test: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}}
''')
        applicable_main, _, _, _ = workflow_applicability(workflow, ["src/app.ts"], "main")
        applicable_develop, _, _, _ = workflow_applicability(workflow, ["src/app.ts"], "develop")
        self.assertTrue(applicable_main)
        self.assertFalse(applicable_develop)

    def test_validation_command_requires_command_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            output = base / "output.log"
            output.write_text("ok\n", encoding="utf-8")
            data = {
                "head_sha": "a" * 40,
                "repository_path": str(base),
                "evidence": [],
                "requirements": [],
                "wrong_implementations": [],
                "scenarios": [],
                "scenario_families": [],
                "passes": {"pass_a": {}, "pass_b": {}},
                "findings": [],
                "later_findings_imported": [],
                "validation_commands": [{"exit_code": 0, "output_path": str(output)}],
            }
            errors: list[str] = []
            validate_evidence(data, base, [], {
                "multi_entity": False,
                "multi_step": False,
                "persistence": False,
                "authorization": False,
                "privacy": False,
                "visual": False,
                "fallback_paths": False,
                "data_migration": False,
                "multiple_entrypoints": [],
            }, base, errors)
            self.assertTrue(any("validation command 0.command" in item for item in errors), errors)

    def test_issue_identity_never_matches_numeric_substring(self) -> None:
        sha = "b" * 40
        self.assertFalse(mentions_issue("Issue 15 handoff", 5))
        self.assertFalse(handoff_matches(f"Issue 15 handoff SHA {sha}", 5, sha))
        self.assertTrue(handoff_matches(f"Issue #5 handoff SHA {sha}", 5, sha))
        self.assertFalse(audit_command_matches(f"@Auditar Issue 15 owner/repo {sha}", "owner/repo", 5, sha))
        self.assertTrue(audit_command_matches(f"@Auditar Issue #5 owner/repo {sha}", "owner/repo", 5, sha))

    def test_only_signed_trusted_external_audit_can_approve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
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
                head_sha="a" * 40,
                base_sha="b" * 40,
                merge_preview_sha="c" * 40,
                cycle=3,
                implementation_context_id="implementation-context-1",
                audit_context_id="independent-audit-context-2",
            )
            sign_report(report, private_key)
            state.write_text(json.dumps({
                "schema_version": 3,
                "repository": "owner/repo",
                "repository_path": str(root / "repo"),
                "issue": 5,
                "base_ref": "main",
                "branch": "feature",
                "pull_request": 10,
                "state": "pronto-para-auditoria-independente",
                "cycle": 3,
                "head_sha": "a" * 40,
                "base_sha": "b" * 40,
                "merge_preview_sha": "c" * 40,
                "implementation_context_id": "implementation-context-1",
                "current_artifacts": {
                    "packet-manifest": {}, "pass-b-plan": {}, "remote-gate": {},
                },
                "invalidated_artifacts": [],
                "findings": [],
                "external_audit": None,
                "audit_history": [],
                "invalidated_audits": [],
                "transitions": [{
                    "at": "2026-01-01T00:00:00+00:00",
                    "from": "verificado",
                    "to": "pronto-para-auditoria-independente",
                }],
                "updated_at": "2026-01-01T00:00:00+00:00",
            }), encoding="utf-8")
            proc = subprocess.run([
                sys.executable, str(ROOT / "scripts/update_orchestration_state.py"),
                str(state), "import-audit", "--report-path", str(report),
                "--trusted-auditors", str(registry),
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(0, proc.returncode, proc.stderr)
            approved = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual("aprovado", approved["state"])
            self.assertEqual("auditor-key-1", approved["external_audit"]["trusted_auditor"]["key_id"])

            # Any post-signature edit invalidates the report.
            tampered = json.loads(report.read_text(encoding="utf-8"))
            tampered["origin"] = "tampered after signing"
            report.write_text(json.dumps(tampered), encoding="utf-8")
            approved["state"] = "pronto-para-auditoria-independente"
            approved["external_audit"] = None
            approved["audit_history"] = []
            state.write_text(json.dumps(approved), encoding="utf-8")
            rejected = subprocess.run([
                sys.executable, str(ROOT / "scripts/update_orchestration_state.py"),
                str(state), "import-audit", "--report-path", str(report),
                "--trusted-auditors", str(registry),
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(2, rejected.returncode)
            self.assertIn("signature", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
