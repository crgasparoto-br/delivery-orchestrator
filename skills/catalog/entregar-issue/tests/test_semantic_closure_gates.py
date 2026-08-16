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


def run(*args: str) -> None:
    subprocess.run([sys.executable, *args], check=True, stdout=subprocess.PIPE, text=True)


def build_case(base: Path, issue_text: str) -> tuple[Path, Path, dict]:
    issue = base / "issue.md"
    issue.write_text(issue_text, encoding="utf-8")
    snapshot = base / "specification-snapshot.json"
    closure = base / "requirement-closure.json"
    run(
        str(ROOT / "scripts/build_specification_snapshot.py"),
        "--repository", "owner/repo", "--issue", "42",
        "--primary-source-id", "SRC-ISSUE",
        "--source", f"issue-body:SRC-ISSUE:{issue}",
        "--out", str(snapshot),
    )
    run(
        str(ROOT / "scripts/init_requirement_closure.py"),
        "--specification-snapshot", str(snapshot), "--out", str(closure),
    )
    data = json.loads(closure.read_text(encoding="utf-8"))
    obligation_ids = []
    for item in data["obligations"]:
        obligation_ids.append(item["id"])
        item.update(
            disposition="covered",
            requirement_ids=["REQ-001"],
            rationale="The canonical obligation is mapped to a runtime requirement.",
        )
    data["scope_reduction_review"] = {"status": "passed", "matches": []}
    data["pass_c"] = {
        "status": "passed",
        "requirement_ids": ["REQ-001"],
        "obligation_ids": obligation_ids,
        "evidence": ["EV-PROD", "EV-PROJ", "EV-CONS", "EV-VIS", "EV-NEG", "EV-DOC"],
        "rederived_without_pr_description": True,
        "reviewed_user_visible_semantics": True,
        "reviewed_producer_consumer_parity": True,
        "reviewed_all_specification_sources": True,
    }
    return snapshot, closure, data


def base_evidence(snapshot: Path, closure: Path, data: dict, repo: Path | None = None, head: str = "") -> dict:
    data["read_model_closures"] = {
        "status": "not-applicable",
        "applicability_reason": "No historical collection or versioned read model is part of this focused fixture.",
        "entries": [], "unconsumed_outputs": [], "unmapped_required_fields": [],
    }
    data["canonical_source_consistency"] = {
        "status": "not-applicable",
        "applicability_reason": "No duplicated semantic field or competing source is part of this focused fixture.",
        "entries": [], "unverified_surfaces": [], "missing_divergent_tests": [],
    }
    data["documentation_consistency"] = {
        "status": "not-applicable",
        "applicability_reason": "No route, architecture, naming, redirect, replacement, or retirement is part of this focused fixture.",
        "old_contract_terms": [], "new_contract_terms": [], "occurrences": [],
        "unresolved_contradictions": [], "searched_outside_diff": False, "search_evidence": [],
    }
    closure.write_text(json.dumps(data), encoding="utf-8")
    packet = snapshot.parent / "packet"
    packet.mkdir(exist_ok=True)
    shutil.copyfile(snapshot, packet / "specification-snapshot.json")
    result = {
        "packet_path": str(packet),
        "requirement_closure": {"path": str(closure), "sha256": sha(closure)},
        "requirements": [{"id": "REQ-001"}],
        "evidence": [
            {"id": "EV-PROD", "type": "code"},
            {"id": "EV-PROJ", "type": "code"},
            {"id": "EV-CONS", "type": "code"},
            {"id": "EV-VIS", "type": "visual"},
            {"id": "EV-NEG", "type": "negative-control"},
            {"id": "EV-DOC", "type": "doc"},
        ],
        "scenarios": [{"id": "SC-001"}],
        "handoff": {
            "issue_completion": "complete",
            "remaining_issue_ids": [],
            "parent_issue_must_remain_open": False,
        },
    }
    if repo is not None:
        result.update(repository_path=str(repo), base_ref="main", head_sha=head)
    return result


class SemanticClosureGateTests(unittest.TestCase):
    def test_initializer_creates_fail_closed_v3_sections(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _, _, data = build_case(base, "- Exibir o valor atualizado na interface.\n")
            self.assertEqual(3, data["schema_version"])
            self.assertEqual("pending", data["read_model_closures"]["status"])
            self.assertEqual("pending", data["canonical_source_consistency"]["status"])
            self.assertEqual("pending", data["documentation_consistency"]["status"])

    def test_history_contract_cannot_hide_unconsumed_backend_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            snapshot, closure, closure_data = build_case(
                base,
                "- Exibir histórico paginado de versões com autoria, origem, vigência e supersessão.\n",
            )
            evidence = base_evidence(snapshot, closure, closure_data)
            closure_data = json.loads(closure.read_text(encoding="utf-8"))
            closure_data["read_model_closures"] = {
                "status": "passed",
                "applicability_reason": "The issue requires a versioned historical read model.",
                "entries": [{
                    "id": "RMC-001", "contract_kind": "history",
                    "requirement_ids": ["REQ-001"],
                    "required_fields": ["version", "author", "origin", "validFrom", "supersedesId"],
                    "producer_evidence": ["EV-PROD"],
                    "public_projection_evidence": ["EV-PROJ"],
                    "consumer_evidence": ["EV-CONS"],
                    "visible_surface_evidence": ["EV-VIS"],
                    "scenario_ids": ["SC-001"],
                    "negative_control_evidence": ["EV-NEG"],
                }],
                "unconsumed_outputs": ["officialGoal.history"],
                "unmapped_required_fields": [],
            }
            closure.write_text(json.dumps(closure_data), encoding="utf-8")
            evidence["requirement_closure"]["sha256"] = sha(closure)
            errors: list[str] = []
            validate_requirement_closure(evidence, base, errors)
            self.assertTrue(any("unconsumed outputs" in error for error in errors), errors)

    def test_canonical_source_requires_deliberately_divergent_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            snapshot, closure, closure_data = build_case(
                base,
                "- Manter a próxima revisão coerente com a fonte canônica em cabeçalho e resumo.\n",
            )
            evidence = base_evidence(snapshot, closure, closure_data)
            closure_data = json.loads(closure.read_text(encoding="utf-8"))
            closure_data["canonical_source_consistency"] = {
                "status": "passed",
                "applicability_reason": "The same semantic date appears in two visible surfaces.",
                "entries": [{
                    "id": "CSC-001",
                    "semantic_field": "next review",
                    "canonical_source": "tracking.nextReviewAt",
                    "alternative_sources": ["assessment.nextReviewAt"],
                    "surfaces": ["patient header", "status summary"],
                    "evidence_ids": ["EV-CONS", "EV-VIS"],
                    "scenario_ids": ["SC-001"],
                    "negative_control_evidence": ["EV-NEG"],
                    "divergent_fixture": {
                        "canonical_value": "2026-09-15",
                        "alternative_values": ["2026-09-15"],
                    },
                }],
                "unverified_surfaces": [],
                "missing_divergent_tests": [],
            }
            closure.write_text(json.dumps(closure_data), encoding="utf-8")
            evidence["requirement_closure"]["sha256"] = sha(closure)
            errors: list[str] = []
            validate_requirement_closure(evidence, base, errors)
            self.assertTrue(any("fixture is not divergent" in error for error in errors), errors)

    def test_documentation_gate_recomputes_global_occurrences_and_rejects_current_legacy_claim(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / "docs").mkdir()
            old_line = "A tela única com abas existente é a linha de base funcional atual."
            (repo / "docs/product.md").write_text(old_line + "\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

            snapshot, closure, closure_data = build_case(
                base,
                "- Substituir a rota legada por workspace contextual e manter redirect de compatibilidade.\n",
            )
            evidence = base_evidence(snapshot, closure, closure_data, repo, head)
            closure_data = json.loads(closure.read_text(encoding="utf-8"))
            closure_data["documentation_consistency"] = {
                "status": "passed",
                "applicability_reason": "The implementation replaces a legacy route and current-state contract.",
                "old_contract_terms": ["tela única com abas"],
                "new_contract_terms": ["workspace contextual"],
                "occurrences": [{
                    "path": "docs/product.md", "line": 1, "text": old_line,
                    "term": "tela única com abas", "classification": "historical",
                    "evidence_ids": ["EV-DOC"],
                }],
                "unresolved_contradictions": [],
                "searched_outside_diff": True,
                "search_evidence": ["EV-DOC"],
            }
            closure.write_text(json.dumps(closure_data), encoding="utf-8")
            evidence["requirement_closure"]["sha256"] = sha(closure)
            errors: list[str] = []
            validate_requirement_closure(evidence, base, errors)
            self.assertTrue(any("describes retired behavior as current" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
