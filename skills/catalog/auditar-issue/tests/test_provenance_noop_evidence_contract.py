from pathlib import Path


def test_provenance_noop_control_requires_two_actor_persisted_evidence():
    text = (Path(__file__).parents[1] / "references" / "evidence-rules.md").read_text()
    assert "PROV-NOOP-001" in text
    assert "ator A" in text and "ator B" in text
    assert "releitura persistida" in text
    assert "cadeia reduzida/legada" in text
    assert "confirmedBy" in text and "confirmedAt" in text
