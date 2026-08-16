from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_controller_defaults_to_observe_only_single_publish():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8").lower()
    policy = (ROOT / "references" / "github-actions-policy.md").read_text(encoding="utf-8").lower()
    assert "somente leitura" in skill
    assert "um candidato" in skill
    assert "nao disparar, reexecutar, cancelar ou aprovar" in policy
    assert "nao pedir aprovacao ao usuario" in policy
    assert "commit vazio" in policy

def test_completed_failure_is_actionable_without_remote_rerun():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8").lower()
    policy = (ROOT / "references" / "github-actions-policy.md").read_text(encoding="utf-8").lower()
    contract = (ROOT / "contracts" / "github-actions-policy.md").read_text(encoding="utf-8").lower()
    for text in (policy, contract):
        assert "completed/failure" in text
        assert "actionable-delivery" in text
        assert "external-infrastructure" in text
        assert "unrelated-preexisting" in text
        assert "sem novo prompt" in text
        assert "continuam proibidos rerun, dispatch" in text
    assert "o novo sha recebe sua propria unica coleta" in skill

