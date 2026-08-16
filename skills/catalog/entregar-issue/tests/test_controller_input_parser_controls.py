from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_stable_controls_and_attack_matrix_are_mandatory():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    reference = (ROOT / "references" / "controller-input-parser-controls.md").read_text(encoding="utf-8")
    evaluator = (ROOT / "scripts" / "evaluate_cycle.py").read_text(encoding="utf-8")
    combined = skill + reference + evaluator
    for token in (
        "input-parser-attack-matrix.json",
        "IP-RAW-001",
        "IP-MODE-001",
        "IP-SCOPE-001",
        "IP-INACTIVE-001",
        "IP-EFFECT-001",
        "consumed_fields",
    ):
        assert token in combined
    assert "valid-plus-external-padding-over-limit" in evaluator
    assert "mode_field_scope_matrix" in evaluator
    assert "scalar-container" in reference
