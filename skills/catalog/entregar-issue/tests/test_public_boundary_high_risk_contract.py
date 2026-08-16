from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_public_boundary_and_browser_retry_controls_are_required():
    workflow = (ROOT / "references" / "implementation-workflow.md").read_text()
    reference = (ROOT / "references" / "implementation-fechamento-alto-risco.md").read_text()
    assert "antes do primeiro adapter ou comando SQL" in workflow
    assert "5xx fail-closed" in workflow
    assert "navegador real" in workflow
    assert "PB-ERR-001" in reference
    assert "origem, destino e categoria" in reference
    assert "mesma chave no retry ambiguo" in reference
    assert "rejeitar teste que apenas busca strings, regex" in reference
