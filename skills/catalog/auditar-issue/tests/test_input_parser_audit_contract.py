from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InputParserAuditContractTests(unittest.TestCase):
    def test_audit_contract_requires_complete_attack_matrix(self):
        combined = "\n".join((
            (ROOT / "SKILL.md").read_text(encoding="utf-8"),
            (ROOT / "references" / "input-parser-audit.md").read_text(encoding="utf-8"),
            (ROOT / "references" / "audit-checklist.md").read_text(encoding="utf-8"),
            (ROOT / "scripts" / "validate_controller_audit_result.py").read_text(encoding="utf-8"),
        ))
        for token in (
            "accepted_modes x consumed_fields x field_scope_placements",
            "generic-container",
            "scalar-container",
            "limite + 1",
            "padding externo",
            "tag amostral",
            "IP-RAW-001",
            "IP-MODE-001",
            "IP-SCOPE-001",
            "IP-INACTIVE-001",
            "IP-EFFECT-001",
        ):
            self.assertIn(token, combined)


if __name__ == "__main__":
    unittest.main()
