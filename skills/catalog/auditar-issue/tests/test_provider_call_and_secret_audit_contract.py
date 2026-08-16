from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")
REFERENCE = (ROOT / "references" / "provider-call-and-secret-audit.md").read_text(encoding="utf-8")


def test_skill_loads_provider_and_secret_audit_reference():
    assert "references/provider-call-and-secret-audit.md" in SKILL
    assert "expandir helpers transitivos ate o SDK" in SKILL


def test_outbound_count_control_detects_hidden_calls():
    assert "OUTBOUND-COUNT-001" in REFERENCE
    assert "uma tentativa configurada produz uma unica chamada" in REFERENCE
    assert "observa duas chamadas ao SDK" in REFERENCE


def test_smoke_audit_forbids_pr_secrets_and_manual_approval():
    for required in (
        "SMOKE-NO-PR-SECRETS-001",
        "ausencia de credenciais reais",
        "aprovacao manual",
        "manual-approval-pending",
        "sem solicitar aprovacao",
        "smoke verde comprova comportamento funcional",
    ):
        assert required in REFERENCE
