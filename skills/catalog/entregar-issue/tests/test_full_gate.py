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
from orchestrator_gate.validator import validate


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args: str, cwd: Path | None = None) -> None:
    subprocess.run([sys.executable, *args], cwd=cwd, check=True, stdout=subprocess.PIPE, text=True)


def fixture(directory: Path, endpoint: str, value) -> None:
    (directory / endpoint_filename(endpoint)).write_text(json.dumps(value), encoding="utf-8")


class FullGateTests(unittest.TestCase):
    def test_minimal_gate_passes_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / "src").mkdir()
            (repo / "src/value.ts").write_text("export const value = 1;\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True)
            base_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            subprocess.run(["git", "checkout", "-qb", "feature"], cwd=repo, check=True)
            (repo / "src/value.ts").write_text("export const value = 2;\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "feature"], cwd=repo, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

            issue = base / "issue.md"
            issue.write_text("# Issue 1\nAlterar o valor preservando o contrato.\n", encoding="utf-8")
            specification = base / "specification-snapshot.json"
            state = base / "state.json"
            packet = base / "packet"
            plan = base / "pass-b.json"
            closure = base / "requirement-closure.json"
            remote = base / "remote.json"
            evidence_path = base / "evidence.json"
            run(str(ROOT / "scripts/build_specification_snapshot.py"), "--repository", "owner/repo", "--issue", "1", "--primary-source-id", "SRC-ISSUE", "--source", f"issue-body:SRC-ISSUE:{issue}", "--out", str(specification))
            run(str(ROOT / "scripts/init_orchestration_state.py"), "--repository", "owner/repo", "--repo-path", str(repo), "--issue", "1", "--base-ref", "main", "--branch", "feature", "--pull-request", "10", "--out", str(state))
            run(str(ROOT / "scripts/transition_orchestration_state.py"), str(state), "--to", "em-correcao", "--reason", "start")
            run(str(ROOT / "scripts/build_audit_packet.py"), "--repo", str(repo), "--base", "main", "--head", "HEAD", "--issue-file", str(issue), "--specification-snapshot", str(specification), "--out", str(packet))
            run(str(ROOT / "scripts/init_requirement_closure.py"), "--specification-snapshot", str(specification), "--out", str(closure))
            run(str(ROOT / "scripts/init_pass_b_plan.py"), "--packet", str(packet), "--out", str(plan))

            plan_data = json.loads(plan.read_text(encoding="utf-8"))
            context = json.loads((packet / "production_context_files.json").read_text(encoding="utf-8"))
            plan_data.update({
                "hypotheses": ["Real export remains old", "Caller observes stale value", "Contract differs from runtime"],
                "scenario_blueprints": ["Import production module", "Run negative control", "Compare contract and output"],
                "reviewed_runtime_context_files": [item["path"] for item in context],
                "unchanged_dependency_risks": [], "reverse_caller_risks": [],
            })
            plan.write_text(json.dumps(plan_data, indent=2) + "\n", encoding="utf-8")

            closure_data = json.loads(closure.read_text(encoding="utf-8"))
            obligation_ids = [item["id"] for item in closure_data["obligations"]]
            for item in closure_data["obligations"]:
                item.update(
                    disposition="covered",
                    requirement_ids=["REQ-001"],
                    rationale="The source obligation is covered by the atomic requirement and runtime scenarios.",
                )
            closure_data["read_model_closures"] = {
                "status": "not-applicable",
                "applicability_reason": "The simple scalar change has no history, versioning, collection, or pagination contract.",
                "entries": [], "unconsumed_outputs": [], "unmapped_required_fields": [],
            }
            closure_data["canonical_source_consistency"] = {
                "status": "not-applicable",
                "applicability_reason": "The contract exposes one scalar in one surface and has no competing semantic source.",
                "entries": [], "unverified_surfaces": [], "missing_divergent_tests": [],
            }
            closure_data["documentation_consistency"] = {
                "status": "not-applicable",
                "applicability_reason": "No route, architecture, naming, redirect, or retired flow changes in this scalar fixture.",
                "old_contract_terms": [], "new_contract_terms": [], "occurrences": [],
                "unresolved_contradictions": [], "searched_outside_diff": False, "search_evidence": [],
            }
            closure_data["scope_reduction_review"] = {"status": "passed", "matches": []}
            closure_data["pass_c"] = {
                "status": "passed",
                "requirement_ids": ["REQ-001"],
                "obligation_ids": obligation_ids,
                "evidence": ["EV-001", "EV-002"],
                "rederived_without_pr_description": True,
                "reviewed_user_visible_semantics": True,
                "reviewed_producer_consumer_parity": True,
                "reviewed_all_specification_sources": True,
            }
            closure.write_text(json.dumps(closure_data, indent=2) + "\n", encoding="utf-8")

            fixtures = base / "fixtures"
            fixtures.mkdir()
            pr_endpoint = "/repos/owner/repo/pulls/10"
            pr = {
                "state": "open", "draft": False, "merged": False, "mergeable": True,
                "mergeable_state": "clean", "merge_commit_sha": "merge-preview-123",
                "head": {"sha": head}, "base": {"ref": "main", "sha": base_sha},
                "body": f"Issue 1 handoff SHA {head}", "html_url": "https://example.test/pr/10",
            }
            fixture(fixtures, pr_endpoint, pr)
            fixture(fixtures, f"/repos/owner/repo/actions/runs?head_sha={head}&page=1&per_page=100", {"total_count": 0, "workflow_runs": []})
            fixture(fixtures, "/repos/owner/repo/issues/10/comments?page=1&per_page=100", [])
            run(str(ROOT / "scripts/collect_remote_gate.py"), "--repo", str(repo), "--repository", "owner/repo", "--pull-request", "10", "--base-ref", "main", "--head-sha", head, "--issue", "1", "--out", str(remote), "--fixture-dir", str(fixtures))

            run(str(ROOT / "scripts/transition_orchestration_state.py"), str(state), "--to", "em-correcao", "--reason", "freeze merge preview", "--merge-preview-sha", "merge-preview-123")
            run(str(ROOT / "scripts/transition_orchestration_state.py"), str(state), "--to", "verificado", "--reason", "final artifacts", "--artifact", f"packet-manifest={packet / 'manifest.json'}", "--artifact", f"pass-b-plan={plan}", "--artifact", f"requirement-closure={closure}", "--artifact", f"remote-gate={remote}")
            run(str(ROOT / "scripts/init_gate_evidence.py"), "--packet", str(packet), "--out", str(evidence_path), "--repository", "owner/repo", "--issue", "1", "--pull-request", "10", "--remote-gate", str(remote), "--orchestration-state", str(state), "--requirement-closure", str(closure))

            ev1 = base / "ev1.log"; ev1.write_text("runtime ok\n", encoding="utf-8")
            ev2 = base / "ev2.log"; ev2.write_text("negative ok\n", encoding="utf-8")
            validation = base / "validation.log"; validation.write_text("validation ok\n", encoding="utf-8")
            data = json.loads(evidence_path.read_text(encoding="utf-8"))
            data["head_sha_after"] = head
            data["risk_profile"]["documentation_impact"] = False
            data["requirements"] = [{"id": "REQ-001", "essential": True, "status": "verified", "evidence": ["EV-001", "EV-002"], "wrong_implementations": ["WI-001"], "scenario_cases": ["SC-001", "SC-002", "SC-003"]}]
            data["wrong_implementations"] = [{"id": "WI-001", "requirement_ids": ["REQ-001"], "description": "The test changes but the production module still exports the old value.", "status": "refuted", "evidence": ["EV-002"]}]
            data["evidence"] = [
                {"id": "EV-001", "type": "command", "claim": "The production module exports the new value.", "command": "node import-value.mjs", "exit_code": 0, "expected_exit": 0, "output_path": str(ev1)},
                {"id": "EV-002", "type": "negative-control", "claim": "The negative control detects the old value.", "command": "node negative-control.mjs", "exit_code": 0, "expected_exit": 0, "output_path": str(ev2), "restored": True, "clean_head_after": head},
            ]
            data["scenarios"] = [
                {"id": "SC-001", "family_id": "F01", "requirement_ids": ["REQ-001"], "description": "Positive production import observes the new value.", "source": "contract-derived", "novel": True, "result": "passed", "evidence": ["EV-001"]},
                {"id": "SC-002", "family_id": "F02", "requirement_ids": ["REQ-001"], "description": "Contradictory control rejects the old value.", "source": "contract-derived", "novel": True, "result": "passed", "evidence": ["EV-002"]},
                {"id": "SC-003", "family_id": "F15", "requirement_ids": ["REQ-001"], "description": "Issue contract remains coherent with runtime output.", "source": "contract-derived", "novel": True, "result": "passed", "evidence": ["EV-001"]},
            ]
            for family in data["scenario_families"]:
                mapping = {"F01": ["SC-001"], "F02": ["SC-002"], "F15": ["SC-003"]}
                if family["id"] in mapping:
                    family.update(applicable=True, rationale="Mandatory family for the simple contract and its evidence.", cases=mapping[family["id"]])
                else:
                    family.update(applicable=False, rationale="Not applicable to a simple non-visual, non-persistent and non-authorized change.", cases=[])
            data["passes"]["pass_a"] = {"status": "passed", "requirement_ids": ["REQ-001"], "evidence": ["EV-001", "EV-002"]}
            data["passes"]["pass_b"] = {"status": "passed", "plan_path": str(plan), "plan_sha256": sha(plan), "novel_scenarios": ["SC-001", "SC-002", "SC-003"], "evidence": ["EV-001", "EV-002"]}
            data["validation_commands"] = [{"command": "python -m unittest", "exit_code": 0, "output_path": str(validation)}]
            data["handoff"]["new_conversation_instruction"] = "ABRA UMA NOVA CONVERSA. Nao execute o comando abaixo nesta conversa."
            data["handoff"]["audit_command"] = f"@Auditar Issue 1 no repositorio owner/repo, PR 10, SHA {head}."
            evidence_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

            report = validate(data, evidence_path, allow_fixture=True)
            self.assertEqual([], report["errors"])
            self.assertEqual("passed", report["result"])


if __name__ == "__main__":
    unittest.main()
