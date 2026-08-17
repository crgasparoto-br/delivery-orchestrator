from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_every_repo_write_must_end_through_terminal_identity_barrier() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert "barreira universal pos-escrita" in skill
    assert "last_material_write_sha" in skill
    assert "post-write-refreeze" in skill
    assert "finalizador universal de identidade" in skill
    assert "current_head != certified_handoff_head" in skill
    assert "Nao devolver controle ao usuario" in skill


def test_generic_post_write_refreeze_is_not_ci_specific() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert "Pos-escrita generico" in skill
    assert "independentemente de ter vindo de CI" in skill
    assert "remediacao, teste, documentacao ou outra Skill de escrita" in skill
