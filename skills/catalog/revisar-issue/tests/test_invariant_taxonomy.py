from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_review_emits_structural_and_forbidden_invariants() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    ref = (ROOT / "references" / "invariant-taxonomy.md").read_text(encoding="utf-8")
    for token in (
        "must_not_behave", "must_reuse", "must_be_single_source",
        "must_not_depend_on", "precedence_invariants", "forbidden_implementation",
    ):
        assert token in skill
        assert token in ref
    assert "implementacao plausivel errada" in skill
