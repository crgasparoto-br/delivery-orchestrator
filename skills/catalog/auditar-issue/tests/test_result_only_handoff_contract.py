from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_auditor_understands_material_and_published_heads() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    ref = (ROOT / "references" / "handoff-certificate-preflight.md").read_text(encoding="utf-8")
    assert "material_head_sha" in skill
    assert "published_handoff_head_sha" in skill
    assert "schema v2 `result-only-child`" in skill
    assert "parent(H) == M" in ref
    assert "allowed_paths" in ref


def test_delivery_not_ready_returns_handoff_only_recovery_signal() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    ref = (ROOT / "references" / "handoff-certificate-preflight.md").read_text(encoding="utf-8")
    for text in (skill, ref):
        assert "return_control_to=entregar-issue" in text
        assert "handoff-not-produced" in text
        assert "handoff-stale" in text
        assert "recovery_scope=handoff-only" in text


def test_pending_ci_does_not_excuse_missing_handoff() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    ref = (ROOT / "references" / "handoff-certificate-preflight.md").read_text(encoding="utf-8")
    assert "CI remoto ainda `pending-no-run`" in skill
    assert "CI pendente nao substitui certificado" in ref
    assert "preflight de gates" in ref
