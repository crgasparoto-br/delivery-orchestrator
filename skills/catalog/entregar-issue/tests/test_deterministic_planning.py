from __future__ import annotations
import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CONTROLLER_SCRIPTS = ROOT / "scripts"
DELIVERY_SCRIPTS = ROOT / "scripts"
for scripts_dir in (CONTROLLER_SCRIPTS, DELIVERY_SCRIPTS):
    value = str(scripts_dir)
    if value not in sys.path:
        sys.path.insert(0, value)


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


CONTROLLER = load_script("issue_loop_controller_cli", CONTROLLER_SCRIPTS / "controller_cli.py")
PLANNER = load_script("delivery_plan_execution", DELIVERY_SCRIPTS / "plan_execution.py")
PROJECTOR = load_script("delivery_project_controller", DELIVERY_SCRIPTS / "project_controller_context.py")
STATE_INITIALIZER = load_script("delivery_state_initializer", DELIVERY_SCRIPTS / "init_orchestration_state.py")


def invoke_main(module, args: list[str]) -> None:
    stdout = io.StringIO()
    with patch.object(sys, "argv", [str(module.__file__), *args]), contextlib.redirect_stdout(stdout):
        result = module.main()
    if result not in (None, 0):
        raise AssertionError(f"{module.__name__} failed with {result}: {stdout.getvalue()}")


class PlanningTests(unittest.TestCase):
    def init_context(self, temp: Path, *, cycle: int = 1) -> Path:
        context = temp / "controller.json"
        invoke_main(CONTROLLER, ["init-context", "--repository", "owner/repo", "--repository-path", str(temp), "--issue", "5", "--base-ref", "main", "--branch", "issue-5", "--controller-cycle", str(cycle), "--out", str(context)])
        return context

    def run_plan(self, context: Path, changed: Path, out: Path, *extra: str) -> dict:
        invoke_main(PLANNER, ["--controller-context", str(context), "--changed-files", str(changed), *extra, "--out", str(out)])
        return json.loads(out.read_text())

    def test_planner_deduplicates_domains_and_controls_publication(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            changed = temp / "changed.json"
            changed.write_text(json.dumps(["src/ui/CallbackForm.tsx", "src/webhook/parser.ts"]))
            out = temp / "plan.json"
            payload = self.run_plan(context, changed, out, "--local-green", "--material-change")
            self.assertEqual(payload["profile"], "critical")
            self.assertIn("design-interface", payload["applicable_skills"])
            self.assertIn("fluxos-conversacionais", payload["applicable_skills"])
            self.assertEqual(len(payload["applicable_skills"]), len(set(payload["applicable_skills"])))
            self.assertTrue(payload["publication"]["allowed"])
            self.assertTrue({"implementation", "documentation-delta", "hygiene"}.issubset({item["stage"] for item in payload["internal_plan"]}))
            self.assertTrue({item["skill"] for item in payload["skill_plan"]}.isdisjoint({"implementar-issue", "higienizacao", "orquestrador", "issue-loop-engineer"}))
            for request in payload["domain_requests"]:
                self.assertEqual(len(request["input_fingerprint"]), 64)
                self.assertIn("requirements", request)
                self.assertIn("paths", request)

    def test_requirement_driven_plan_works_before_files_are_known(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            changed = temp / "changed.json"
            changed.write_text("[]")
            requirements = temp / "requirements.json"
            requirements.write_text(json.dumps({"requirements": [
                {"id": "R1", "statement": "Exibir um formulario responsivo para confirmar a acao."},
                {"id": "R2", "statement": "Persistir o estado e retomar pelo callback em mensagem futura."},
            ]}))
            payload = self.run_plan(context, changed, temp / "plan.json", "--requirements", str(requirements))
            self.assertEqual(payload["profile"], "critical")
            self.assertIn("interface", payload["risk_signals"])
            self.assertIn("continuation", payload["risk_signals"])
            self.assertIn("design-interface", payload["applicable_skills"])
            self.assertIn("fluxos-conversacionais", payload["applicable_skills"])
            for request in payload["domain_requests"]:
                self.assertEqual(request["requirements"], ["R1", "R2"])

    def test_dependency_changes_propagate_and_metrics_do_not(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            changed = temp / "changed.json"
            changed.write_text(json.dumps(["src/service.py"]))
            first_path = temp / "first.json"
            first = self.run_plan(context, changed, first_path)

            invoke_main(CONTROLLER, ["record-metric", "--context", str(context), "--metric", "subskill_calls"])
            second_path = temp / "second.json"
            second = self.run_plan(context, changed, second_path, "--previous-plan", str(first_path))
            self.assertEqual(second["invalidated_stages"], [])
            self.assertEqual(second["reusable_stages"], second["execution_order"])
            self.assertEqual(first["stages"]["contract"]["fingerprint"], second["stages"]["contract"]["fingerprint"])

            manifest = temp / "manifest.json"
            manifest.write_text(json.dumps({"sources": [{"path": "README.md", "sha256": "b" * 64}]}))
            invoke_main(CONTROLLER, ["refresh-context", "--context", str(context), "--source-manifest-file", str(manifest)])
            third = self.run_plan(context, changed, temp / "third.json", "--previous-plan", str(second_path))
            self.assertIn("preflight", third["reusable_stages"])
            self.assertNotIn("contract", third["reusable_stages"])
            contract_index = third["execution_order"].index("contract")
            self.assertEqual(third["invalidated_stages"], third["execution_order"][contract_index:])
            self.assertIn("dependency-changed:contract", third["stages"]["implementation"]["invalidated_by"])

    def test_external_domain_requests_are_canonicalized_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            changed = temp / "changed.json"
            changed.write_text(json.dumps(["src/page.tsx"]))
            requests = temp / "requests.json"
            requests.write_text(json.dumps({"domain_requests": [
                {"skill": "design-interface", "requirements": ["R2", "R1"], "paths": ["src/page.tsx"], "reason": "implementer"},
                {"skill": "design-interface", "requirements": ["R1", "R2"], "paths": ["src/page.tsx"], "reason": "planner"},
            ]}))
            payload = self.run_plan(context, changed, temp / "plan.json", "--domain-requests", str(requests))
            design = [item for item in payload["domain_requests"] if item["skill"] == "design-interface"]
            self.assertEqual(len(design), 1)
            self.assertEqual(design[0]["requirements"], ["R1", "R2"])
            self.assertIn("implementer", design[0]["reason"])
            self.assertIn("planner", design[0]["reason"])

    def test_projected_context_preserves_controller_cycle(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp, cycle=3)
            out = temp / "execution.json"
            invoke_main(PROJECTOR, ["--controller-context", str(context), "--out", str(out)])
            payload = json.loads(out.read_text())
            self.assertEqual(payload["cycle"], 3)
            self.assertEqual(payload["controller_cycle"], 3)
            self.assertEqual(payload["cycle_authority"], "entregar-issue")

    def test_state_projection_uses_controller_context_without_duplicate_identity_args(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            subprocess.run(["git", "init", "-q", str(temp)], check=True)
            subprocess.run(["git", "-C", str(temp), "config", "user.email", "test@example.com"], check=True)
            subprocess.run(["git", "-C", str(temp), "config", "user.name", "Test"], check=True)
            (temp / "README.md").write_text("test\n")
            subprocess.run(["git", "-C", str(temp), "add", "README.md"], check=True)
            subprocess.run(["git", "-C", str(temp), "commit", "-qm", "init"], check=True)
            branch = subprocess.check_output(["git", "-C", str(temp), "branch", "--show-current"], text=True).strip()
            context = temp / "controller.json"
            invoke_main(CONTROLLER, ["init-context", "--repository", "owner/repo", "--repository-path", str(temp), "--issue", "5", "--base-ref", branch, "--branch", branch, "--controller-cycle", "4", "--out", str(context)])
            state = temp / "state.json"
            invoke_main(STATE_INITIALIZER, ["--controller-context", str(context), "--out", str(state)])
            payload = json.loads(state.read_text())
            self.assertEqual(payload["controller_cycle"], 4)
            self.assertEqual(payload["cycle"], 4)
            self.assertEqual(payload["cycle_authority"], "entregar-issue")

    def test_identity_reobservation_reuses_the_entire_plan(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            changed = temp / "changed.json"
            changed.write_text(json.dumps(["src/service.py"]))
            first_path = temp / "first.json"
            first = self.run_plan(context, changed, first_path)

            current = json.loads(context.read_text())
            identity = temp / "identity.json"
            identity.write_text(json.dumps({
                "head_sha": current["identity"]["head_sha"],
                "base_sha": current["identity"]["base_sha"],
                "merge_preview_sha": current["identity"]["merge_preview_sha"],
                "observed_at": "2026-08-05T12:30:00Z",
            }))
            invoke_main(CONTROLLER, [
                "refresh-context", "--context", str(context), "--identity-file", str(identity),
            ])
            second = self.run_plan(
                context, changed, temp / "second.json", "--previous-plan", str(first_path)
            )
            self.assertEqual(second["invalidated_stages"], [])
            self.assertEqual(second["context_fingerprints"], first["context_fingerprints"])
            self.assertEqual(
                {name: item["fingerprint"] for name, item in second["stages"].items()},
                {name: item["fingerprint"] for name, item in first["stages"].items()},
            )

    def test_workflow_inventory_invalidates_only_remote_audit_and_decision(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            changed = temp / "changed.json"
            changed.write_text(json.dumps(["src/service.py"]))
            first_path = temp / "first.json"
            self.run_plan(context, changed, first_path)

            inventory = temp / "workflows.json"
            inventory.write_text(json.dumps({"workflow_inventory": [{
                "path": ".github/workflows/ci.yml",
                "classification": "observable",
                "sha256": "a" * 64,
            }]}))
            invoke_main(CONTROLLER, [
                "refresh-context", "--context", str(context), "--workflow-inventory-file", str(inventory),
            ])
            second = self.run_plan(
                context, changed, temp / "second.json", "--previous-plan", str(first_path)
            )
            self.assertEqual(second["invalidated_stages"], ["remote-gate", "audit", "decision"])
            self.assertTrue(second["stages"]["freeze"]["reused"])
            self.assertFalse(second["stages"]["remote-gate"]["reused"])

    def test_new_work_item_reopens_implementation_without_path_change(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            changed = temp / "changed.json"
            changed.write_text(json.dumps(["src/service.py"]))
            first_items = temp / "items-1.json"
            first_items.write_text(json.dumps({"work_items": [{"id": "F-1", "severity": "blocking"}]}))
            first_path = temp / "first.json"
            self.run_plan(context, changed, first_path, "--work-items", str(first_items))

            second_items = temp / "items-2.json"
            second_items.write_text(json.dumps({"work_items": [
                {"id": "F-1", "severity": "blocking"},
                {"id": "F-2", "severity": "blocking", "reason": "new evidence"},
            ]}))
            second = self.run_plan(
                context, changed, temp / "second.json",
                "--work-items", str(second_items), "--previous-plan", str(first_path),
            )
            self.assertEqual(second["reusable_stages"], ["preflight", "contract"])
            self.assertEqual(second["invalidated_stages"], second["execution_order"][2:])
            self.assertNotEqual(second["work_item_fingerprint"], json.loads(first_path.read_text())["work_item_fingerprint"])


    def test_observed_diff_does_not_invalidate_implementation_output(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            empty = temp / "empty.json"
            empty.write_text("[]")
            first_path = temp / "first.json"
            first = self.run_plan(context, empty, first_path)

            observed = temp / "observed.json"
            observed.write_text(json.dumps(["src/service.py"]))
            second = self.run_plan(
                context, observed, temp / "second.json", "--previous-plan", str(first_path)
            )
            self.assertTrue(second["stages"]["implementation"]["reused"])
            self.assertEqual(
                next(item for item in second["internal_plan"] if item["stage"] == "implementation")["action"],
                "reuse-candidate",
            )
            self.assertFalse(second["stages"]["documentation"]["reused"])

    def test_new_work_item_expands_stable_implementation_scope(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)
            empty = temp / "empty.json"
            empty.write_text("[]")
            first_path = temp / "first.json"
            self.run_plan(context, empty, first_path)

            observed = temp / "observed.json"
            observed.write_text(json.dumps(["src/service.py"]))
            work_items = temp / "work-items.json"
            work_items.write_text(json.dumps({"work_items": [{
                "id": "F-1", "severity": "blocking", "paths": ["src/service.py"]
            }]}))
            second = self.run_plan(
                context, observed, temp / "second.json",
                "--work-items", str(work_items), "--previous-plan", str(first_path),
            )
            implementation = next(
                item for item in second["internal_plan"] if item["stage"] == "implementation"
            )
            self.assertEqual(implementation["action"], "run")
            self.assertEqual(implementation["paths"], ["src/service.py"])

    def test_fast_paths_skip_hygiene_and_runtime_suite_when_not_applicable(self):
        with tempfile.TemporaryDirectory() as temp_value:
            temp = Path(temp_value)
            context = self.init_context(temp)

            docs = temp / "docs.json"
            docs.write_text(json.dumps(["docs/guide.md"]))
            docs_plan = self.run_plan(context, docs, temp / "docs-plan.json")
            self.assertEqual(docs_plan["profile"], "light")
            self.assertFalse(docs_plan["change_classification"]["behavioral_change"])
            self.assertNotIn("final-suite", docs_plan["required_gates"])
            hygiene = next(item for item in docs_plan["internal_plan"] if item["stage"] == "hygiene")
            self.assertEqual(hygiene["action"], "not-applicable")

            config = temp / "config.json"
            config.write_text(json.dumps(["config/runtime.yaml"]))
            config_plan = self.run_plan(context, config, temp / "config-plan.json")
            self.assertTrue(config_plan["change_classification"]["runtime_config_touched"])
            self.assertTrue(config_plan["change_classification"]["behavioral_change"])
            self.assertIn("final-suite", config_plan["required_gates"])
            hygiene = next(item for item in config_plan["internal_plan"] if item["stage"] == "hygiene")
            self.assertEqual(hygiene["action"], "not-applicable")

if __name__ == "__main__":
    unittest.main()
