from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")
WORKFLOW = (ROOT / "references" / "implementation-workflow.md").read_text(encoding="utf-8")
REFERENCE = (ROOT / "references" / "implementation-provider-call-governance.md").read_text(encoding="utf-8")


def test_skill_loads_provider_governance_for_external_integrations():
    assert "implementation-*" in SKILL
    assert "uma tentativa do executor produza no maximo uma chamada outbound" in WORKFLOW


def test_reference_forbids_hidden_probe_and_requires_discriminant_call_count():
    assert "segunda chamada oculta" in REFERENCE
    assert "uma tentativa configurada = uma chamada outbound" in REFERENCE
    assert "OUTBOUND-COUNT-001" in REFERENCE


def test_reference_forbids_pr_secret_workflow_and_manual_approval():
    for required in (
        "Nao criar workflow de smoke com credenciais reais",
        "workflow_change_authorized=false",
        "manual_approval_workflow_authorized=false",
        "nao pedir aprovacao ao usuario",
        "SMOKE-NO-PR-SECRETS-001",
    ):
        assert required in REFERENCE
