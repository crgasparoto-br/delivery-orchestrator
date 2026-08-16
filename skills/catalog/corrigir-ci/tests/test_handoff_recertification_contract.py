from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")
REFERENCE = (ROOT / "references" / "handoff-recertification.md").read_text(encoding="utf-8")


class HandoffRecertificationContractTest(unittest.TestCase):
    def test_green_requires_terminal_handoff_after_material_fix(self):
        self.assertIn("terminal-handoff-valid", SKILL)
        self.assertIn("nunca `stale-after-ci-fix`", SKILL)
        self.assertIn("result-only-child", SKILL)

    def test_same_invocation_refreeze_is_mandatory(self):
        self.assertIn("Executar imediatamente `entregar-issue` na mesma invocacao", SKILL)
        self.assertIn("Nao apenas imprimir/devolver esses campos e encerrar", SKILL)
        self.assertIn("mesma invocacao", REFERENCE)

    def test_blocked_recertification_is_not_green(self):
        self.assertIn("blocked-handoff-recertification", SKILL)
        self.assertIn("nunca pode ser tratado como `green`", SKILL)
        self.assertIn("nunca como `green` ou `corrigido`", REFERENCE)

    def test_skill_never_owns_delivery_artifacts(self):
        self.assertIn("Nunca editar, copiar, corrigir ou regenerar diretamente `.audit/entregar-issue/*`", SKILL)
        self.assertIn("nao editar `.audit/entregar-issue/*` diretamente", REFERENCE)

    def test_no_repository_or_issue_specific_coupling(self):
        combined = (SKILL + "\n" + REFERENCE).lower()
        self.assertNotIn("solverfin", combined)
        self.assertNotRegex(combined, r"issue\s+#?\d+")
        self.assertNotRegex(combined, r"pr\s+#?\d+")


if __name__ == "__main__":
    unittest.main()
