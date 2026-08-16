from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")
REFERENCE = (ROOT / "references" / "gate-preflight.md").read_text(encoding="utf-8")
REPORT = (ROOT / "references" / "report-template.md").read_text(encoding="utf-8")


def test_skill_loads_gate_preflight_reference():
    assert "references/gate-preflight.md" in SKILL
    assert "Preflight de gates" in SKILL


def test_candidate_caused_requires_discriminating_evidence():
    assert "red-candidate-caused" in REFERENCE
    assert "arquivo reportado pelo gate pertence a `changed_files`" in REFERENCE
    assert "Se a atribuicao for ambigua" in REFERENCE


def test_declared_reached_passed_prevents_false_coverage():
    for required in (
        "declared",
        "reached",
        "passed",
        "testes posteriores ficam `reached=false`, `passed=false`",
    ):
        assert required in REFERENCE
    assert "declared/reached/passed" in SKILL
    assert "Nao marcar teste posterior ao primeiro abort como executado" in REPORT


def test_blocker_bounded_limits_expensive_rework_without_hiding_cheap_blockers():
    for required in (
        "blocker-bounded",
        "cancelar provas caras nao relacionadas",
        "outros blockers observaveis sem nova infraestrutura ou suite cara",
        "Nao encerrar no primeiro blocker",
    ):
        assert required in REFERENCE
    assert "blocker-bounded" in SKILL


def test_remote_runtime_state_precedes_pr_narrative():
    assert "metadata remota atual e runs/statuses existentes" in REFERENCE
    assert "descricao da PR" in REFERENCE
    assert "preferir metadata remota" in SKILL


def test_green_job_reuse_is_scope_bounded():
    assert "aceitar o resultado como evidencia de execucao para aquele escopo" in REFERENCE
    assert "nao extrapolar um job visual verde" in REFERENCE
    assert "Reutilizar job verde oficial" in SKILL
