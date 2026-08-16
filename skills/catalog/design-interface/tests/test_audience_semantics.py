from pathlib import Path


def test_skill_requires_audience_specific_negative_controls():
    skill = Path(__file__).resolve().parents[1] / 'SKILL.md'
    text = skill.read_text(encoding='utf-8')
    assert 'contrato explicito por audiencia' in text
    assert 'copy das audiencias irmas' in text
    assert 'rota autenticada, rota publica tokenizada e area administrativa' in text
