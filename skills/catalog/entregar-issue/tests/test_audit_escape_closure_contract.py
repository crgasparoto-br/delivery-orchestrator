from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_delivery_blocks_reaudit_until_escape_class_is_closed() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    escape = (ROOT / "references" / "audit-escape-closure.md").read_text(encoding="utf-8")
    implementation = (ROOT / "references" / "implementation-workflow.md").read_text(encoding="utf-8")
    temporal = (ROOT / "references" / "temporal-consistency-gate.md").read_text(encoding="utf-8")
    liveness = (ROOT / "references" / "reference-liveness-gate.md").read_text(encoding="utf-8")
    saturation = (ROOT / "references" / "risk-saturation-gate.md").read_text(encoding="utf-8")

    assert "audit-escape-closure.json" in skill
    assert "nao reenviar para nova auditoria" in skill
    assert "no minimo dois `sibling_cases`" in escape
    assert "prevencao e deteccao" in escape
    assert "TEMP-ASOF-001" in temporal
    assert "evento posterior nao pode alterar" in temporal
    assert "passado, atual e futuro" in temporal
    assert "TEMP-PERIOD-001" in temporal
    assert "TEMP-DEST-001" in temporal
    assert "REF-LIVE-001" in liveness
    assert "reference-liveness" in saturation
    assert "risk-saturation.json" in skill
    assert "ALERT-REOPEN-001" in implementation
    assert "estado + alerta ja persistidos" in implementation
    assert "zero duplicatas em retries" in implementation
