from __future__ import annotations

import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.visual_validation import validate_visual_metrics


class VisualValidationTests(unittest.TestCase):
    def base_metrics(self, interactions):
        return {
            "schema_version": 2,
            "head_sha": "abcdef1234567",
            "routes": [{
                "route": "/cards",
                "viewports": ["mobile", "tablet", "desktop"],
                "long_content_or_zoom": True,
                "keyboard_only": True,
                "accessibility_tree": {"captured": True, "expected_roles_present": True},
                "control_interactions": interactions,
                "dynamic_surfaces": [], "table_surfaces": [], "dialog_surfaces": [],
            }],
        }

    def test_link_requires_enter_not_space(self) -> None:
        contract = {"routes": ["/cards"], "controls": [{"route": "/cards", "name": "details", "control_role": "link"}]}
        errors = []
        validate_visual_metrics(self.base_metrics([{"name": "details", "keys_passed": ["enter"]}]), "abcdef1234567", contract, errors)
        self.assertEqual([], errors)

    def test_button_requires_enter_and_space(self) -> None:
        contract = {"routes": ["/cards"], "controls": [{"route": "/cards", "name": "open", "control_role": "button"}]}
        errors = []
        validate_visual_metrics(self.base_metrics([{"name": "open", "keys_passed": ["enter"]}]), "abcdef1234567", contract, errors)
        self.assertTrue(any("space" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
