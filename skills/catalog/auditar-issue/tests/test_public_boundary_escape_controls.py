from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_auditor_requires_discriminant_public_boundary_and_browser_controls() -> None:
    skill = (ROOT / 'SKILL.md').read_text()
    reference = (ROOT / 'references' / 'adversarial-control-design.md').read_text()

    assert 'identificadores malformados por papeis irmaos' in skill
    assert 'navegador real' in skill
    assert 'PB-ERR-001' in reference
    assert 'code=P0001' in reference
    assert 'accountId`, `destinationAccountId` e `categoryId' in reference
    assert 'duas submissoes no mesmo turno' in reference
    assert 'regex, snapshot estatico' in reference
