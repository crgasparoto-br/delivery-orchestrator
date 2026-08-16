from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_restart_retry_must_use_same_public_entrypoint_without_auxiliary_recovery() -> None:
    text = (ROOT / "SKILL.md").read_text(encoding="utf-8")

    assert "RESTART-IDEM-001" in text
    assert "mesmo entrypoint publico" in text
    assert "mesma chave" in text
    assert "sem GET/health-check/listagem intermediaria" in text
    assert "antes da persistencia | depois da persistencia | depois do outbound | antes da finalizacao" in text
    assert "contagem de outbound/efeito" in text
