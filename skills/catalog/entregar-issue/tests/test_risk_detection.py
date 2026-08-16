from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.risk_detection import detect


class RiskDetectionTests(unittest.TestCase):
    def test_catch_and_api_entrypoints_are_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src/api.ts").write_text("try { run(); } catch { useMemory(); }", encoding="utf-8")
            (repo / "src/webhook.ts").write_text("export const webhook = () => true", encoding="utf-8")
            report = detect(repo, ["src/api.ts", "src/webhook.ts"])
            self.assertTrue(report["flags"]["fallback_paths"])
            self.assertEqual(2, len(report["flags"]["multiple_entrypoints"]))

    def test_deleted_sensitive_code_is_detected_from_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            report = detect(repo, ["src/old.ts"], "- authorizeTenant(user)\n- const repository = db.client")
            self.assertTrue(report["flags"]["authorization"])
            self.assertTrue(report["flags"]["persistence"])


    def test_escape_risk_classes_are_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            report = detect(
                repo,
                [],
                "Exibir histórico paginado com autoria. Manter a próxima revisão coerente com a fonte canônica. Substituir a rota legada por workspace com redirect.",
            )
            self.assertTrue(report["flags"]["read_model_closure"])
            self.assertTrue(report["flags"]["canonical_source_consistency"])
            self.assertTrue(report["flags"]["documentation_contract_transition"])


if __name__ == "__main__":
    unittest.main()
