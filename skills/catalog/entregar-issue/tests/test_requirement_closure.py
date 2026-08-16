from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.requirement_closure_validation import validate_requirement_closure


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_snapshot(base: Path, sources: list[tuple[str, str, Path]], primary: str = "SRC-ISSUE") -> Path:
    out = base / "specification-snapshot.json"
    command = [
        sys.executable,
        str(ROOT / "scripts/build_specification_snapshot.py"),
        "--repository", "owner/repo",
        "--issue", "1",
        "--primary-source-id", primary,
        "--out", str(out),
    ]
    for kind, source_id, path in sources:
        command.extend(["--source", f"{kind}:{source_id}:{path}"])
    subprocess.run(command, check=True, stdout=subprocess.PIPE, text=True)
    return out


def init_closure(base: Path, snapshot: Path) -> Path:
    out = base / "closure.json"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/init_requirement_closure.py"),
            "--specification-snapshot", str(snapshot),
            "--out", str(out),
        ],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return out


class RequirementClosureTests(unittest.TestCase):
    def test_initializer_marks_semantic_and_catalog_clauses_across_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            issue = base / "issue.md"
            comment = base / "comment.md"
            sheet = base / "sheet.md"
            issue.write_text(
                "# Contrato\n"
                "- Exibir a última atividade resumida.\n"
                "- Diferenciar os demais eventos suportados.\n",
                encoding="utf-8",
            )
            comment.write_text(
                "- Validar o consentimento vigente dentro da transação.\n"
                "- Após converter, exibir confirmação, próximas ações e filtro.\n",
                encoding="utf-8",
            )
            sheet.write_text(
                "- Usar parâmetros equivalentes às siglas e métodos da planilha.\n"
                "- Consumir dores e medicamentos para gerar alertas técnicos.\n",
                encoding="utf-8",
            )
            snapshot = build_snapshot(base, [
                ("issue-body", "SRC-ISSUE", issue),
                ("issue-comment", "SRC-COMMENT", comment),
                ("spreadsheet-extract", "SRC-SHEET", sheet),
            ])
            closure = init_closure(base, snapshot)
            data = json.loads(closure.read_text(encoding="utf-8"))
            by_text = {item["source_text"]: item for item in data["obligations"]}
            self.assertIn("observable", by_text["Exibir a última atividade resumida."]["flags"])
            self.assertTrue(
                {"observable", "exhaustive"}.issubset(
                    by_text["Diferenciar os demais eventos suportados."]["flags"]
                )
            )
            self.assertTrue(
                {"freshness", "atomicity"}.issubset(
                    by_text["Validar o consentimento vigente dentro da transação."]["flags"]
                )
            )
            self.assertIn(
                "source-catalog",
                by_text["Usar parâmetros equivalentes às siglas e métodos da planilha."]["flags"],
            )
            self.assertIn(
                "semantic-effect",
                by_text["Consumir dores e medicamentos para gerar alertas técnicos."]["flags"],
            )
            self.assertEqual({"SRC-ISSUE", "SRC-COMMENT", "SRC-SHEET"}, {
                item["source_id"] for item in data["source_coverage"]
            })

    def test_validator_rejects_missing_semantics_and_closed_domain_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            issue = base / "issue.md"
            issue.write_text(
                "Exibir a última atividade resumida.\n"
                "Diferenciar os demais eventos suportados.\n",
                encoding="utf-8",
            )
            snapshot = build_snapshot(base, [("issue-body", "SRC-ISSUE", issue)])
            closure = init_closure(base, snapshot)
            closure_data = json.loads(closure.read_text(encoding="utf-8"))
            first, second = closure_data["obligations"]
            first.update(
                disposition="covered",
                requirement_ids=["REQ-001"],
                rationale="Covered by the first runtime requirement.",
            )
            second.update(
                disposition="covered",
                requirement_ids=["REQ-002"],
                inventory_ids=["INV-001"],
                assertion_ids=["OBS-002"],
                rationale="Covered by the second runtime requirement.",
            )
            closure_data["domain_inventories"] = [{
                "id": "INV-001",
                "name": "eventos da timeline",
                "closed_world": True,
                "producer_sources": ["server/events.ts"],
                "consumer_sources": ["client/labels.ts"],
                "values": [{
                    "value": "goal_review_requested",
                    "producer_evidence": ["EV-PROD"],
                    "consumer_evidence": ["EV-CONS"],
                    "scenario_ids": ["SC-002"],
                }],
                "unmapped_values": [],
                "fallback_policy": "open-world-generic",
                "rationale": "The set is emitted by canonical producers.",
            }]
            closure_data["observable_assertions"] = [{
                "id": "OBS-002",
                "description": "Each canonical event keeps a distinct visible label.",
                "requirement_ids": ["REQ-002"],
                "obligation_ids": [second["id"]],
                "evidence_ids": ["EV-CONS"],
                "scenario_ids": ["SC-002"],
                "negative_control_evidence": ["EV-NEG"],
            }]
            closure_data["scope_reduction_review"] = {"status": "passed", "matches": []}
            closure_data["pass_c"] = {
                "status": "passed",
                "requirement_ids": ["REQ-001", "REQ-002"],
                "obligation_ids": [first["id"], second["id"]],
                "evidence": ["EV-CONS", "EV-NEG"],
                "rederived_without_pr_description": True,
                "reviewed_user_visible_semantics": True,
                "reviewed_producer_consumer_parity": True,
                "reviewed_all_specification_sources": True,
            }
            closure.write_text(json.dumps(closure_data), encoding="utf-8")
            packet = base / "packet"
            packet.mkdir()
            shutil.copyfile(snapshot, packet / "specification-snapshot.json")
            data = {
                "packet_path": str(packet),
                "requirement_closure": {"path": str(closure), "sha256": sha(closure)},
                "requirements": [{"id": "REQ-001"}, {"id": "REQ-002"}],
                "evidence": [
                    {"id": "EV-PROD", "type": "code"},
                    {"id": "EV-CONS", "type": "visual"},
                    {"id": "EV-NEG", "type": "negative-control"},
                ],
                "scenarios": [{"id": "SC-002"}],
                "handoff": {
                    "issue_completion": "complete",
                    "remaining_issue_ids": [],
                    "parent_issue_must_remain_open": False,
                },
            }
            errors: list[str] = []
            validate_requirement_closure(data, base, errors)
            self.assertTrue(any(f"{first['id']} requires an observable assertion" in item for item in errors))
            self.assertTrue(any("cannot rely on a generic open-world fallback" in item for item in errors))

    def test_validator_rejects_unapproved_deferral(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            issue = base / "issue.md"
            issue.write_text("- Implementar a interface e a API.\n", encoding="utf-8")
            snapshot = build_snapshot(base, [("issue-body", "SRC-ISSUE", issue)])
            closure = init_closure(base, snapshot)
            closure_data = json.loads(closure.read_text(encoding="utf-8"))
            obligation = closure_data["obligations"][0]
            obligation.update(
                disposition="deferred",
                scope_decision=None,
                rationale="A implementação decidiu deixar a interface para depois.",
            )
            closure_data["scope_reduction_review"] = {"status": "passed", "matches": []}
            closure_data["pass_c"] = {
                "status": "passed",
                "requirement_ids": [],
                "obligation_ids": [obligation["id"]],
                "evidence": ["EV-NEG"],
                "rederived_without_pr_description": True,
                "reviewed_user_visible_semantics": True,
                "reviewed_producer_consumer_parity": True,
                "reviewed_all_specification_sources": True,
            }
            closure.write_text(json.dumps(closure_data), encoding="utf-8")
            packet = base / "packet"
            packet.mkdir()
            shutil.copyfile(snapshot, packet / "specification-snapshot.json")
            data = {
                "packet_path": str(packet),
                "requirement_closure": {"path": str(closure), "sha256": sha(closure)},
                "requirements": [],
                "evidence": [{"id": "EV-NEG", "type": "negative-control"}],
                "scenarios": [],
                "handoff": {
                    "issue_completion": "partial",
                    "remaining_issue_ids": [],
                    "parent_issue_must_remain_open": True,
                },
            }
            errors: list[str] = []
            validate_requirement_closure(data, base, errors)
            self.assertTrue(any("requires a canonical scope decision" in item for item in errors))


    def test_validator_recomputes_scope_reduction_phrases_from_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / "README.md").write_text("# Projeto\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True)
            subprocess.run(["git", "checkout", "-qb", "feature"], cwd=repo, check=True)
            (repo / "README.md").write_text(
                "# Projeto\n\nInterface pendente para próxima evolução.\n",
                encoding="utf-8",
            )
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "docs"], cwd=repo, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

            issue = base / "issue.md"
            issue.write_text("- Implementar backend e interface.\n", encoding="utf-8")
            snapshot = build_snapshot(base, [("issue-body", "SRC-ISSUE", issue)])
            closure = init_closure(base, snapshot)
            closure_data = json.loads(closure.read_text(encoding="utf-8"))
            obligation = closure_data["obligations"][0]
            obligation.update(
                disposition="covered",
                requirement_ids=["REQ-001"],
                rationale="The complete backend and interface obligation is implemented.",
            )
            closure_data["scope_reduction_review"] = {"status": "passed", "matches": []}
            closure_data["pass_c"] = {
                "status": "passed",
                "requirement_ids": ["REQ-001"],
                "obligation_ids": [obligation["id"]],
                "evidence": ["EV-001"],
                "rederived_without_pr_description": True,
                "reviewed_user_visible_semantics": True,
                "reviewed_producer_consumer_parity": True,
                "reviewed_all_specification_sources": True,
            }
            closure.write_text(json.dumps(closure_data), encoding="utf-8")
            packet = base / "packet"
            packet.mkdir()
            shutil.copyfile(snapshot, packet / "specification-snapshot.json")
            data = {
                "repository_path": str(repo),
                "base_ref": "main",
                "head_sha": head,
                "packet_path": str(packet),
                "requirement_closure": {"path": str(closure), "sha256": sha(closure)},
                "requirements": [{"id": "REQ-001"}],
                "evidence": [{"id": "EV-001", "type": "negative-control"}],
                "scenarios": [],
                "handoff": {
                    "issue_completion": "complete",
                    "remaining_issue_ids": [],
                    "parent_issue_must_remain_open": False,
                },
            }
            errors: list[str] = []
            validate_requirement_closure(data, base, errors)
            self.assertTrue(any("scope reduction review differs" in item for item in errors))


if __name__ == "__main__":
    unittest.main()
