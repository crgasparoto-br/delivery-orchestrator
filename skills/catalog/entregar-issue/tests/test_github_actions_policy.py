from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from orchestrator_gate.risk_validation import required_artifact_kinds
from orchestrator_gate.visual_validation import validate_visual_contract



def test_visual_contract_allows_no_workflow_paths():
    errors = []
    validate_visual_contract(
        {
            "routes": ["/today"],
            "validator_paths": ["scripts/validate-visual.js"],
            "workflow_paths": [],
            "documentation_paths": ["docs/visual.md"],
            "controls": [],
            "controls_rationale": "No interactive controls changed in this route.",
            "dynamic_surfaces": [],
            "dynamic_surfaces_rationale": "No dynamic surfaces are present here.",
            "table_surfaces": [],
            "table_surfaces_rationale": "No table surfaces are present here.",
            "dialog_surfaces": [],
            "dialog_surfaces_rationale": "No dialog surfaces are present here.",
        },
        errors,
    )
    assert not errors


def test_remote_artifacts_are_not_inferred_from_risk_categories():
    risk = {
        "visual": True,
        "persistence": True,
        "data_migration": True,
        "documentation_impact": True,
        "audit_packet_published": False,
    }
    assert required_artifact_kinds(risk) == set()
    risk["audit_packet_published"] = True
    assert required_artifact_kinds(risk) == {"audit-manifest"}


def test_policy_is_observe_only_and_forbids_manual_approval():
    text = (ROOT / "references" / "github-actions-policy.md").read_text(encoding="utf-8").lower()
    assert "observe-only" in text
    assert "nao disparar, reexecutar, cancelar ou aprovar" in text
    assert "nao criar `workflow_dispatch`" in text
    assert "aprovacao manual" in text
