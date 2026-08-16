import json
import unittest
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parents[1]


class ControllerModeContractTests(unittest.TestCase):
    def test_skill_returns_to_controller(self):
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("controller-adversarial", text)
        self.assertIn("nao orientar nova conversa", text)
        self.assertIn("controller_disposition", text)
        self.assertIn("internally-approved", text)
        self.assertIn("Nunca usar `approved-operationally`", text)
        schema = (ROOT / "schemas" / "subskill-result.schema.json").read_text(encoding="utf-8")
        self.assertIn("internally-approved", schema)
        self.assertNotIn("\"approved-operationally\"", schema)

    def test_recommendations_do_not_create_reservations(self):
        text = (ROOT / "references" / "controller-mode.md").read_text(encoding="utf-8")
        self.assertIn("Recomendacoes opcionais isoladas nao produzem ressalva", text)

    def test_controller_result_schema_rejects_operational_approval(self):
        schema = json.loads((ROOT / "schemas" / "subskill-result.schema.json").read_text(encoding="utf-8"))
        payload = {
            "schema_version": 1, "contract_version": "2026-08-06.2", "skill": "auditar-issue", "mode": "controller-adversarial",
            "status": "passed", "requirements": [{}], "findings": [], "validations": [],
            "artifacts": [], "changed_files": [], "limitations": [], "requires_refreeze": False,
            "input_fingerprint": "a" * 64, "reused": False,
            "data": {
                "controller_disposition": "internally-approved",
                "assurance_level": "controller-adversarial",
                "approval_scope": "internal-only", "release_gate_satisfied": False,
                "verdict": "Aprovado", "requirements": [{}], "blocking_findings": [],
                "recommendations": [], "gates": [{}], "limitations": [], "identity": {},
                "modifications_detected": False,
                "evidence_artifacts": {
                    name: {"path": f"{name}.json", "sha256": "a" * 64}
                    for name in ("source_manifest", "requirements_rederivation", "coverage_matrix", "controller_audit_report")
                },
            },
        }
        jsonschema.Draft202012Validator(schema).validate(payload)
        payload["data"]["controller_disposition"] = "approved-operationally"
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.Draft202012Validator(schema).validate(payload)

    def test_controller_mode_never_claims_independence(self):
        text = (ROOT / "references" / "controller-mode.md").read_text(encoding="utf-8")
        self.assertIn("nao declarar independencia", text)


if __name__ == "__main__":
    unittest.main()
