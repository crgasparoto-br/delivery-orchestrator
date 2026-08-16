from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_single_controller_plans_once_and_internalizes_core_work():
    skill = read("SKILL.md")
    efficiency = read("references/controller-execution-efficiency.md")
    planner = read("scripts/plan_execution.py")
    assert "uma unica camada de controle" in skill
    assert "Calcular o plano uma vez" in skill
    assert "internal_plan" in planner
    assert "skill_plan" in planner
    assert "recalcular o mesmo plano" in efficiency


def test_implementation_output_does_not_self_invalidate():
    skill = read("SKILL.md")
    planner = read("scripts/plan_execution.py")
    assert "implementation_scope" in skill
    assert "Observed changed files are implementation outputs" in planner
    assert "produced_diff" in skill


def test_single_writer_and_local_closure_are_required():
    skill = read("SKILL.md")
    implementation = read("references/implementation-workflow.md")
    audit = (ROOT.parent / "auditar-issue" / "SKILL.md").read_text(encoding="utf-8")
    assert "write_owner" in skill
    assert "Fechamento por requisito" in implementation
    assert "controle negativo" in implementation
    assert "Agrupar findings" in skill
    assert "Tentar refutar" in audit


def test_legacy_core_skills_are_not_delegated():
    planner = read("scripts/plan_execution.py")
    generated_core_entries = "('implementar-issue', 'implementation'" in planner or "('higienizacao', 'hygiene'" in planner
    assert not generated_core_entries
