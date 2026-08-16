from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_tenant_scoped_performance_gate_rejects_global_denominator():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    evidence = (ROOT / "references" / "controller-evidence-enforcement.md").read_text(encoding="utf-8")
    assert "usar como denominador somente a cardinalidade do escopo alvo" in skill
    assert "total global" in evidence
    assert "ruido deliberado fora do escopo" in evidence
    assert "consulta estruturalmente identica" in evidence
