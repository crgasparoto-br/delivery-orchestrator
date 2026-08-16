from __future__ import annotations

import hashlib
import json
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_generated_contract_matches_delivery_controller():
    skill = Path(__file__).resolve().parents[1]
    canonical = skill.parent / "entregar-issue" / "contracts"
    version = json.loads((canonical / "version.json").read_text())
    local = json.loads((skill / "contracts/version.json").read_text())
    assert local == {
        "schema_version": 1,
        "contract_version": version["contract_version"],
        "canonical_owner": "entregar-issue",
        "generated_copy": True,
    }
    assert digest(skill / "schemas/subskill-result.schema.json") == digest(canonical / "subskill-result.schema.json")
    assert json.loads((skill / "contracts/manifest.json").read_text()) == json.loads((canonical / "manifest.json").read_text())


def test_composed_mode_uses_delivery_contract():
    skill = Path(__file__).resolve().parents[1]
    text = (skill / "SKILL.md").read_text(encoding="utf-8")
    assert "references/delivery-contract.md" in text
    assert "issue-loop-engineer" not in text
    assert "orquestrador" not in text.lower()
