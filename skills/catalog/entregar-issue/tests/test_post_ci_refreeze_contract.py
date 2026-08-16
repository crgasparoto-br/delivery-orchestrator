from __future__ import annotations

import unittest
from pathlib import Path


DELIVERY = Path(__file__).resolve().parents[1]
SKILLS_ROOT = DELIVERY.parent
CI = SKILLS_ROOT / "corrigir-ci"


class PostCiRefreezeContractTests(unittest.TestCase):
    def test_ci_remediation_must_return_to_delivery_after_head_change(self):
        ci_skill = (CI / "SKILL.md").read_text()
        ci_loop = (CI / "references/ci-loop.md").read_text()

        self.assertIn("stale-after-ci-fix", ci_skill)
        self.assertIn("return_control_to=entregar-issue", ci_skill)
        self.assertIn("reason=post-ci-refreeze", ci_skill)
        self.assertIn("Nunca editar, copiar, corrigir ou regenerar diretamente `.audit/entregar-issue/*`", ci_skill)
        self.assertIn("CI verde do novo SHA comprova somente", ci_loop)
        self.assertIn("proibir encaminhamento a `auditar-issue`", ci_loop)

    def test_delivery_owns_material_head_refreeze(self):
        delivery_skill = (DELIVERY / "SKILL.md").read_text()
        composition = (DELIVERY / "references/composition-contract.md").read_text()
        certificate = (DELIVERY / "references/handoff-certificate.md").read_text()

        self.assertIn("reason=post-ci-refreeze", delivery_skill)
        self.assertIn("material head", delivery_skill)
        self.assertIn("result-only-child", delivery_skill)
        self.assertIn("`corrigir-ci`: owner temporario", composition)
        self.assertIn('"reason": "post-ci-refreeze"', composition)
        self.assertIn("Mudanca **material** posterior ao freeze", certificate)
        self.assertIn("result-only child autorizado nao e drift material", certificate)

    def test_identity_drift_rule_has_no_embedded_delivery_identity(self):
        import re

        combined = "\n".join([
            (CI / "SKILL.md").read_text(),
            (CI / "references/ci-loop.md").read_text(),
            (DELIVERY / "SKILL.md").read_text(),
            (DELIVERY / "references/composition-contract.md").read_text(),
            (DELIVERY / "references/handoff-certificate.md").read_text(),
        ])
        forbidden_patterns = (
            r"github\.com/[^/\s]+/[^/\s]+",
            r"#[0-9]+",
            r"\b(?:issue|pr)\s*#?[0-9]+\b",
            r"\b[0-9a-f]{12,40}\b",
        )
        for pattern in forbidden_patterns:
            self.assertIsNone(re.search(pattern, combined, flags=re.IGNORECASE), pattern)


if __name__ == "__main__":
    unittest.main()
