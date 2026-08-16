from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")
RUNTIME = (ROOT / "references" / "runtime-resource-resolution.md").read_text(encoding="utf-8")
GATE = (ROOT / "references" / "gate-preflight.md").read_text(encoding="utf-8")
REPORT = (ROOT / "references" / "report-template.md").read_text(encoding="utf-8")


def test_skill_owned_scripts_are_not_repo_requirements():
    assert "relativos ao pacote instalado da Skill `auditar-issue`" in SKILL
    assert "nunca ao repositorio auditado" in SKILL
    assert "Nunca exigir que o repositorio versione, copie ou venda scripts internos da Skill" in RUNTIME


def test_preflight_resolves_from_skill_root():
    assert "<AUDIT_SKILL_ROOT>/scripts/check_delivery_preflight.py" in SKILL
    assert "<AUDIT_SKILL_ROOT>/scripts/validate_handoff_certificate.py" in (ROOT / "references" / "handoff-certificate-preflight.md").read_text(encoding="utf-8")


def test_runtime_limitation_is_inconclusive_not_candidate_failure():
    assert "# RESULTADO: INCONCLUSIVA" in SKILL
    assert "audit-runtime-limitation" in SKILL
    assert "nao produz finding da issue" in RUNTIME
    assert "nao entra em `blocker_bounded`" in RUNTIME
    assert "INCONCLUSIVA" in REPORT


def test_runtime_limitation_does_not_enter_blocker_bounded():
    assert "Nao entrar em `blocker-bounded` por `audit-runtime-limitation`" in GATE


def test_connector_native_fallback_precedes_runtime_limitation():
    assert "nao concluir imediatamente `audit-runtime-limitation`" in RUNTIME
    assert "check_connector_preflight.py" in RUNTIME
    assert "fallback connector-native" in SKILL
