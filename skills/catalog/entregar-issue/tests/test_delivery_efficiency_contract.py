from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_remote_gate_forbids_polling_for_future_ci():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    remote = (ROOT / "references" / "remote-gate.md").read_text(encoding="utf-8")
    efficiency = (ROOT / "references" / "controller-execution-efficiency.md").read_text(encoding="utf-8")
    assert "remote_gate=pending-no-run" in skill
    assert "nunca fazer polling" in skill
    assert "A coleta remota e snapshot, nao monitoramento" in remote
    assert "fazer polling" in efficiency


def test_multi_file_publication_is_atomic_by_default():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    efficiency = (ROOT / "references" / "controller-execution-efficiency.md").read_text(encoding="utf-8")
    assert "publicar atomicamente em um unico commit" in skill
    assert "commit material e um commit posterior exclusivamente de resultados" in skill
    assert "preparar todos os blobs e uma unica tree/commit" in efficiency


def test_audit_remediation_reuses_structured_findings():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    efficiency = (ROOT / "references" / "controller-execution-efficiency.md").read_text(encoding="utf-8")
    assert "usar os findings como work items prontos" in skill
    assert "nao repetir discovery, readiness ou decomposicao integral da issue" in efficiency


def test_preflight_selects_execution_capability_once():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert "`local-git`, `connector-only` ou `artifact-bundle`" in skill
    assert "nao repetir clone" in skill


def test_head_stability_guard_does_not_force_branch_backwards():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    efficiency = (ROOT / "references" / "controller-execution-efficiency.md").read_text(encoding="utf-8")
    assert "nao aplicar patch obsoleto nem mover a branch para tras" in skill
    assert "nao force-push para restaurar SHA antigo" in efficiency

def test_completed_remote_failure_reopens_remediation_without_polling():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    remote = (ROOT / "references" / "remote-gate.md").read_text(encoding="utf-8")
    efficiency = (ROOT / "references" / "controller-execution-efficiency.md").read_text(encoding="utf-8")
    assert "`completed` com falha" in skill
    assert "actionable-delivery" in skill
    assert "sem pedir novo prompt ao usuario" in skill
    assert "completed/failure` nao e pendencia temporal" in remote
    assert "retornar a remediacao na mesma invocacao" in remote
    assert "completed/failure` nao e estado de espera" in efficiency
    assert "novo SHA com novo orcamento de uma observacao" in efficiency


def test_pending_ci_ends_without_waiting_but_after_handoff():
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    remote = (ROOT / "references" / "remote-gate.md").read_text(encoding="utf-8")
    assert "run `queued`, `in_progress`, `waiting` ou equivalente" in skill
    assert "continuar para publicacao do handoff sem polling" in skill
    assert "continuar a finalizacao do handoff" in remote
    assert "Nao fazer polling, `sleep`, backoff" in remote

