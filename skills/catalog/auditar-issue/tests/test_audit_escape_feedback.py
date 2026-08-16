from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_audit_emits_reusable_escape_controls_and_sibling_sweep() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    ref = (ROOT / "references" / "audit-escape-feedback.md").read_text(encoding="utf-8")

    assert "escape-control.json" in skill
    assert "audit_escape" in skill
    assert "ao menos dois casos irmaos" in ref
    assert "TEMP-ASOF-001" in ref
    assert "RESTART-IDEM-001" in ref
    assert "mesmo entrypoint publico" in ref
    assert "sem GET/health-check/operacao auxiliar" in ref
