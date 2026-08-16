from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INIT = ROOT / "scripts" / "init_loop_state.py"
MIGRATE = ROOT / "scripts" / "migrate_loop_state.py"
HASH = "a" * 64


class StateToolTests(unittest.TestCase):
    def test_initializer_creates_fail_closed_v5_state(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "state.json"
            result = subprocess.run([
                sys.executable, str(INIT),
                "--repository", "owner/repo", "--issue", "1", "--branch", "issue-1",
                "--head-sha", "1" * 40, "--base-sha", "2" * 40,
                "--issue-snapshot-sha256", HASH, "--diff-sha256", HASH,
                "--skills-sha256", HASH, "--out", str(out),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(out.read_text())
            self.assertEqual(state["schema_version"], 5)
            self.assertEqual(state["audit"]["verdict"], "not-run")
            self.assertFalse(state["requirements_inventory_complete"])
            self.assertTrue(all(item["status"] == "missing" for item in state["artifacts"]))
            self.assertIsNone(state["prior_internal_approval"])
            self.assertEqual(state["audit_escapes"], [])
            self.assertEqual(state["adversarial_controls"], [])

    def test_v3_migration_invalidates_legacy_approval(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "v3.json"
            target = Path(temp) / "v5.json"
            source.write_text(json.dumps({
                "schema_version": 3,
                "execution_mode": "standard",
                "frozen_identity": {"head_sha": "1" * 40, "pull_request": None},
                "audit": {"validity": "controller-adversarial", "verdict": "Aprovado"},
                "requirements_inventory_complete": True,
                "gate_inventory_complete": True,
                "requirements": [{"id": "REQ-1", "status": "Implementado", "evidence": "old.log"}],
                "findings": [],
            }), encoding="utf-8")
            result = subprocess.run([
                sys.executable, str(MIGRATE), "--state", str(source), "--out", str(target)
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(target.read_text())
            self.assertEqual(state["schema_version"], 5)
            self.assertEqual(state["audit"]["validity"], "absent")
            self.assertEqual(state["audit"]["verdict"], "not-run")
            self.assertFalse(state["requirements_inventory_complete"])
            self.assertFalse(state["gate_inventory_complete"])
            self.assertEqual(state["requirements"][0]["origin"], "legacy-unmapped")
            self.assertEqual(state["requirements"][0]["negative_controls"], [])


if __name__ == "__main__":
    unittest.main()
