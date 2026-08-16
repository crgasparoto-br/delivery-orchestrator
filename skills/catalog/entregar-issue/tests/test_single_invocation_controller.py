import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SingleInvocationControllerTests(unittest.TestCase):
    def test_context_initializer_records_controller_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "execution-context.json"
            command = [
                sys.executable,
                str(ROOT / "scripts" / "init_execution_context.py"),
                "--repository", "owner/repo",
                "--repo-path", temp,
                "--issue", "541",
                "--base-ref", "main",
                "--branch", "issue-541",
                "--controller-mode", "delivery-single-invocation",
                "--controller-context-id", "loop-context-001",
                "--out", str(out),
            ]
            subprocess.run(command, check=True, capture_output=True, text=True)
            payload = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(payload["controller_mode"], "delivery-single-invocation")
            self.assertEqual(payload["controller_context_id"], "loop-context-001")
            self.assertEqual(payload["controller_cycle_limit"], 10)
            self.assertEqual(payload["return_control_to"], "entregar-issue")
            self.assertFalse(payload["workflow_change_authorized"])
            self.assertFalse(payload["manual_approval_workflow_authorized"])
            self.assertEqual(payload["remote_action_mode"], "observe-only")
            self.assertEqual(payload["publish_policy"], "single-final-candidate")

    def test_skill_declares_neutral_audit_handoff(self):
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("pacote neutro", text)
        self.assertIn("auditar-issue", text)
        self.assertIn("delivery-single-invocation", text)
        self.assertNotIn("Invocar `orquestrador`", text)

    def test_github_actions_policy_forbids_manual_approval_and_reruns(self):
        text = (ROOT / "references" / "github-actions-policy.md").read_text(encoding="utf-8")
        self.assertIn("Nao disparar, reexecutar, cancelar ou aprovar", text)
        self.assertIn("nao criar", text.lower())
        self.assertIn("aprovacao manual", text.lower())

    def test_controller_reference_forbids_new_prompt(self):
        text = (ROOT / "references" / "single-invocation-controller.md").read_text(encoding="utf-8")
        self.assertIn("Nunca pedir ao usuario que abra nova conversa", text)


if __name__ == "__main__":
    unittest.main()
