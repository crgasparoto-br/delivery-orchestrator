from pathlib import Path


def test_provenance_noop_control_is_mandatory():
    text = (Path(__file__).parents[1] / "references" / "implementation-workflow.md").read_text()
    assert "PROV-NOOP-001" in text
    assert "ator A" in text and "ator B" in text
    assert "semanticamente identico" in text
    assert "schema reduzido/legado" in text
