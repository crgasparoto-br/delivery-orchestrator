from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from orchestrator_gate.evidence_validation import validate_evidence
from orchestrator_gate.github_api import GitHubClient, endpoint_filename
from orchestrator_gate.risk_validation import validate_risk
from orchestrator_gate.schema_validation import validate_against_schema
from orchestrator_gate.visual_validation import validate_visual_contract
from orchestrator_gate.workflow_rules import load_workflow_text, workflow_applicability
from runtime_graph import build_runtime_context


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture(directory: Path, endpoint: str, value) -> None:
    (directory / endpoint_filename(endpoint)).write_text(json.dumps(value), encoding="utf-8")


class AdversarialRegressionTests(unittest.TestCase):
    def test_evidence_links_cannot_be_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            output = base / "ev.log"
            output.write_text("ok\n", encoding="utf-8")
            data = {
                "head_sha": "a" * 40,
                "repository_path": str(base),
                "evidence": [{
                    "id": "EV-1", "type": "command", "claim": "runtime execution evidence",
                    "command": "true", "exit_code": 0, "output_path": str(output),
                }],
                "requirements": [{
                    "id": "REQ-1", "essential": True, "status": "verified",
                    "evidence": ["EV-1", "EV-1"], "wrong_implementations": ["WI-1"],
                    "scenario_cases": ["SC-1"],
                }],
                "wrong_implementations": [{
                    "id": "WI-1", "description": "A plausible incorrect implementation remains active.",
                    "status": "refuted", "requirement_ids": ["REQ-1"], "evidence": [],
                }],
                "scenarios": [{
                    "id": "SC-1", "family_id": "F01", "description": "A contract derived positive scenario.",
                    "requirement_ids": ["REQ-1"], "result": "passed", "evidence": [],
                    "novel": True, "source": "contract-derived",
                }],
                "scenario_families": [
                    {"id": "F01", "applicable": True, "cases": ["SC-1"]},
                    {"id": "F02", "applicable": True, "cases": ["SC-1"]},
                    {"id": "F15", "applicable": True, "cases": ["SC-1"]},
                ],
                "passes": {
                    "pass_a": {"status": "passed", "requirement_ids": ["REQ-1"], "evidence": []},
                    "pass_b": {"status": "passed", "plan_path": str(base / "missing.json"), "novel_scenarios": ["SC-1"], "evidence": []},
                },
                "findings": [], "later_findings_imported": [],
                "validation_commands": [{"command": "true", "exit_code": 0, "output_path": str(output)}],
            }
            errors: list[str] = []
            validate_evidence(data, base, [], {
                "multi_entity": False, "multi_step": False, "persistence": False,
                "authorization": False, "privacy": False, "visual": False,
                "fallback_paths": False, "data_migration": False, "multiple_entrypoints": [],
            }, base, errors)
            self.assertTrue(any("wrong implementation WI-1: evidence is required" in error for error in errors))
            self.assertTrue(any("scenario SC-1: evidence is required" in error for error in errors))
            self.assertTrue(any("Pass A must contain evidence" in error for error in errors))
            self.assertTrue(any("Pass B must contain evidence" in error for error in errors))

    def test_python_missing_relative_import_marks_graph_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "pkg").mkdir()
            (repo / "pkg/a.py").write_text("from .missing import value\n", encoding="utf-8")
            _, _, unresolved, coverage = build_runtime_context(repo, ["pkg/a.py"])
            self.assertTrue(unresolved)
            self.assertFalse(coverage["complete"])

    def test_go_same_package_files_are_included(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "go.mod").write_text("module example.test/app\n", encoding="utf-8")
            (repo / "lib").mkdir()
            (repo / "lib/a.go").write_text("package lib\n", encoding="utf-8")
            (repo / "lib/b.go").write_text("package lib\n", encoding="utf-8")
            files, _, unresolved, coverage = build_runtime_context(repo, ["lib/a.go"])
            self.assertIn("lib/b.go", {item["path"] for item in files})
            self.assertFalse(unresolved)
            self.assertTrue(coverage["complete"])

    def test_paths_outside_pull_request_do_not_change_applicability(self) -> None:
        workflow = load_workflow_text("""
name: CI
on:
  pull_request:
jobs:
  test:
    strategy:
      matrix:
        paths: [unrelated/**]
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
""")
        applicable, _, evidence, events = workflow_applicability(workflow, ["src/app.ts"])
        self.assertTrue(applicable)
        self.assertEqual({"pull_request"}, events)
        self.assertEqual([], evidence["events"]["pull_request"]["paths"])

    def test_empty_visual_contract_is_rejected(self) -> None:
        errors: list[str] = []
        validate_visual_contract({
            "routes": [], "validator_paths": [], "workflow_paths": [], "documentation_paths": [],
            "controls": [], "controls_rationale": "", "dynamic_surfaces": [], "dynamic_surfaces_rationale": "",
            "table_surfaces": [], "table_surfaces_rationale": "", "dialog_surfaces": [], "dialog_surfaces_rationale": "",
        }, errors)
        self.assertTrue(any("routes" in error for error in errors))
        self.assertTrue(any("controls_rationale" in error for error in errors))

    def test_malformed_persistence_risk_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            packet = base / "packet"; packet.mkdir()
            detection = packet / "risk_detection.json"
            detection.write_text(json.dumps({"flags": {}, "high_confidence": {}}), encoding="utf-8")
            data = {
                "repository_path": str(base),
                "risk_detection": {"path": str(detection), "sha256": sha(detection)},
                "risk_overrides": [],
                "risk_profile": {
                    "multi_entity": False, "multi_step": False, "persistence": True,
                    "durable_persistence_required": True, "authorization": False, "privacy": False,
                    "visual": False, "data_migration": False, "fallback_paths": False,
                    "documentation_impact": False, "audit_packet_published": False,
                    "multiple_entrypoints": [], "persistence_boundaries": [{}],
                    "external_dependencies": [None], "eligibility_sources": [None],
                    "transactional_authorization_operations": [{}],
                },
            }
            errors: list[str] = []
            validate_risk(data, packet, base, errors)
            self.assertTrue(any("persistence_boundaries[0].name" in error for error in errors))
            self.assertTrue(any("external_dependencies" in error for error in errors))
            self.assertTrue(any("durable persistence" in error for error in errors))

    def test_json_schemas_are_executed(self) -> None:
        errors: list[str] = []
        validate_against_schema({"schema_version": 1}, ROOT / "schemas/orchestration-state.schema.json", "state", errors)
        self.assertTrue(errors)

    def test_pagination_collects_second_page(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixtures = root / "fixtures"; fixtures.mkdir()
            endpoint = "/repos/owner/repo/actions/runs?head_sha=abc"
            first = [{"id": value} for value in range(100)]
            fixture(fixtures, endpoint + "&page=1&per_page=100", {"total_count": 101, "workflow_runs": first})
            fixture(fixtures, endpoint + "&page=2&per_page=100", {"total_count": 101, "workflow_runs": [{"id": 100}]})
            client = GitHubClient(root / "raw", fixtures)
            payload, raw = client.paginate(endpoint, "runs", "workflow_runs")
            self.assertEqual(101, len(payload["workflow_runs"]))
            self.assertEqual(2, len(raw))

    def _collector_repo(self, root: Path) -> tuple[Path, str, str]:
        repo = root / "repo"; repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
        (repo / ".github/workflows").mkdir(parents=True)
        (repo / ".github/workflows/ci.yml").write_text("""
name: CI
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
""", encoding="utf-8")
        (repo / "a.txt").write_text("a\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
        subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True)
        base_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        subprocess.run(["git", "checkout", "-qb", "feature"], cwd=repo, check=True)
        (repo / "a.txt").write_text("b\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "feature"], cwd=repo, check=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        return repo, base_sha, head

    def test_workflow_dispatch_does_not_satisfy_pr_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); repo, base_sha, head = self._collector_repo(root)
            fixtures = root / "fixtures"; fixtures.mkdir()
            pr = {
                "state": "open", "draft": False, "merged": False, "mergeable": True,
                "mergeable_state": "clean", "merge_commit_sha": "merge1234",
                "head": {"sha": head}, "base": {"ref": "main", "sha": base_sha},
                "body": f"Issue 1 SHA {head}", "html_url": "https://example.test/pr/1",
            }
            fixture(fixtures, "/repos/owner/repo/pulls/1", pr)
            run = {
                "id": 10, "path": ".github/workflows/ci.yml", "event": "workflow_dispatch",
                "head_sha": head, "status": "completed", "conclusion": "success", "created_at": "2026-01-01T00:00:00Z",
                "name": "CI",
            }
            fixture(fixtures, f"/repos/owner/repo/actions/runs?head_sha={head}&page=1&per_page=100", {"total_count": 1, "workflow_runs": [run]})
            fixture(fixtures, "/repos/owner/repo/actions/runs/10/artifacts?page=1&per_page=100", {"total_count": 0, "artifacts": []})
            fixture(fixtures, "/repos/owner/repo/issues/1/comments?page=1&per_page=100", [])
            out = root / "remote.json"
            proc = subprocess.run([
                sys.executable, str(ROOT / "scripts/collect_remote_gate.py"), "--repo", str(repo),
                "--repository", "owner/repo", "--pull-request", "1", "--base-ref", "main",
                "--head-sha", head, "--issue", "1", "--out", str(out), "--fixture-dir", str(fixtures),
            ], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(5, proc.returncode)
            self.assertIn("no current PR run", proc.stderr)

    def test_artifact_name_does_not_assign_semantic_kind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); repo, base_sha, head = self._collector_repo(root)
            fixtures = root / "fixtures"; fixtures.mkdir()
            pr = {
                "state": "open", "draft": False, "merged": False, "mergeable": True,
                "mergeable_state": "clean", "merge_commit_sha": "merge1234",
                "head": {"sha": head}, "base": {"ref": "main", "sha": base_sha},
                "body": f"Issue 1 SHA {head}", "html_url": "https://example.test/pr/1",
            }
            fixture(fixtures, "/repos/owner/repo/pulls/1", pr)
            run = {
                "id": 10, "path": ".github/workflows/ci.yml", "event": "pull_request",
                "head_sha": head, "status": "completed", "conclusion": "success", "created_at": "2026-01-01T00:00:00Z",
                "name": "CI",
            }
            fixture(fixtures, f"/repos/owner/repo/actions/runs?head_sha={head}&page=1&per_page=100", {"total_count": 1, "workflow_runs": [run]})
            fixture(fixtures, "/repos/owner/repo/actions/runs/10/jobs?page=1&per_page=100", {
                "total_count": 1, "jobs": [{"id": 100, "name": "test", "status": "completed", "conclusion": "success",
                "steps": [{"number": 1, "name": "run", "status": "completed", "conclusion": "success"}]}],
            })
            fixture(fixtures, "/repos/owner/repo/actions/runs/10/artifacts?page=1&per_page=100", {
                "total_count": 1, "artifacts": [{"id": 99, "name": "visual-a11y-report", "digest": "sha256:" + "a" * 64}],
            })
            fixture(fixtures, "/repos/owner/repo/issues/1/comments?page=1&per_page=100", [])
            with zipfile.ZipFile(fixtures / "artifact-99.zip", "w") as archive:
                archive.writestr("report.txt", "not an attestation")
            out = root / "remote.json"
            subprocess.run([
                sys.executable, str(ROOT / "scripts/collect_remote_gate.py"), "--repo", str(repo),
                "--repository", "owner/repo", "--pull-request", "1", "--base-ref", "main",
                "--head-sha", head, "--issue", "1", "--out", str(out), "--fixture-dir", str(fixtures),
            ], check=True, stdout=subprocess.PIPE, text=True)
            snapshot = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual("other", snapshot["artifacts"][0]["kind"])
            self.assertFalse(snapshot["artifacts"][0]["kind_verified"])


    def test_pr_run_with_zero_jobs_is_not_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); repo, base_sha, head = self._collector_repo(root)
            fixtures = root / "fixtures"; fixtures.mkdir()
            pr = {
                "state": "open", "draft": False, "merged": False, "mergeable": True,
                "mergeable_state": "clean", "merge_commit_sha": "merge1234",
                "head": {"sha": head}, "base": {"ref": "main", "sha": base_sha},
                "body": f"Issue 1 SHA {head}", "html_url": "https://example.test/pr/1",
            }
            fixture(fixtures, "/repos/owner/repo/pulls/1", pr)
            run = {
                "id": 10, "path": ".github/workflows/ci.yml", "event": "pull_request",
                "head_sha": head, "status": "completed", "conclusion": "success",
                "created_at": "2026-01-01T00:00:00Z", "name": "CI",
            }
            fixture(fixtures, f"/repos/owner/repo/actions/runs?head_sha={head}&page=1&per_page=100", {"total_count": 1, "workflow_runs": [run]})
            fixture(fixtures, "/repos/owner/repo/actions/runs/10/jobs?page=1&per_page=100", {"total_count": 0, "jobs": []})
            fixture(fixtures, "/repos/owner/repo/actions/runs/10/artifacts?page=1&per_page=100", {"total_count": 0, "artifacts": []})
            fixture(fixtures, "/repos/owner/repo/issues/1/comments?page=1&per_page=100", [])
            out = root / "remote.json"
            subprocess.run([
                sys.executable, str(ROOT / "scripts/collect_remote_gate.py"), "--repo", str(repo),
                "--repository", "owner/repo", "--pull-request", "1", "--base-ref", "main",
                "--head-sha", head, "--issue", "1", "--out", str(out), "--fixture-dir", str(fixtures),
            ], check=True, stdout=subprocess.PIPE, text=True)
            snapshot = json.loads(out.read_text(encoding="utf-8"))
            selected = snapshot["workflows"][0]["run"]
            self.assertIsNotNone(selected)
            self.assertFalse(selected["jobs_checked"])
            self.assertEqual(0, selected["job_count"])

    def test_state_findings_are_managed_by_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state.json"
            state.write_text(json.dumps({
                "schema_version": 3, "state": "verificado", "head_sha": "a" * 40,
                "base_sha": "b" * 40, "merge_preview_sha": "c" * 40,
                "findings": [], "external_audit": None, "audit_history": [], "invalidated_audits": [],
                "implementation_context_id": "implementation-context-test",
                "updated_at": "2026-01-01T00:00:00+00:00",
            }), encoding="utf-8")
            script = ROOT / "scripts/update_orchestration_state.py"
            subprocess.run([
                sys.executable, str(script), str(state), "add-finding", "--id", "A-1",
                "--severity", "high", "--escape-class", "missing-runtime-dependency",
                "--generalized-invariant", "Toda dependencia local de runtime deve integrar o pacote auditado.",
                "--evidence", "EV-1",
            ], check=True, stdout=subprocess.PIPE, text=True)
            added = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual("em-correcao", added["state"])
            self.assertEqual("open", added["findings"][0]["status"])
            subprocess.run([
                sys.executable, str(script), str(state), "resolve-finding", "--id", "A-1",
                "--literal-scenario", "SC-1", "--sibling-scenario", "SC-2",
                "--sibling-scenario", "SC-3", "--evidence", "EV-2",
            ], check=True, stdout=subprocess.PIPE, text=True)
            resolved = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual("resolved-and-reverified", resolved["findings"][0]["status"])


if __name__ == "__main__":
    unittest.main()
