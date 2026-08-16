from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_connector_only_must_produce_consumable_handoff_or_block_before_audit() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    ref = (ROOT / "references" / "connector-only-handoff.md").read_text(encoding="utf-8")
    assert "connector-only-handoff.md" in skill
    assert "result-only-child" in skill
    assert "materializar inputs/artefatos em workspace efemero" in skill
    assert "nao chamar `auditar-issue`" in skill
    assert "nao publicar uma entrega que apenas remova o pacote antigo" in ref
    assert "parent desse commit e o material head" in ref
    assert "handoff-not-produced|handoff-stale" in ref


def test_handoff_certificate_documents_non_self_referential_identity() -> None:
    ref = (ROOT / "references" / "handoff-certificate.md").read_text(encoding="utf-8")
    assert "autorreferencia" in ref
    assert "material_head_sha" in ref
    assert '"mode": "result-only-child"' in ref
    assert "parent(H) == M" in ref
