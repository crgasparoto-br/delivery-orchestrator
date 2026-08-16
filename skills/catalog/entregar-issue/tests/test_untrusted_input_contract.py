from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_skill_requires_raw_boundary_and_complete_field_matrix():
    content = (ROOT / "references" / "implementation-workflow.md").read_text(encoding="utf-8")
    reference = (ROOT / "references" / "implementation-untrusted-input-contract.md").read_text(encoding="utf-8")
    combined = content + reference
    for token in (
        "representacao bruta",
        "matriz modo x invariante x familia de campo",
        "accepted_modes x consumed_fields x field_scope_placements",
        "um campo representativo",
        "limite + 1",
        "padding externo",
        "fronteira publica",
        "IP-RAW-001",
        "IP-MODE-001",
        "IP-SCOPE-001",
        "IP-INACTIVE-001",
        "IP-EFFECT-001",
    ):
        assert token in combined
