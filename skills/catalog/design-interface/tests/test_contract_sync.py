import hashlib
import json
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_contract_copy_matches_issue_loop_controller() -> None:
    skill = Path(__file__).resolve().parents[1]
    canonical = skill.parent / 'entregar-issue' / 'contracts'
    canonical_version = json.loads((canonical / 'version.json').read_text())['contract_version']
    assert json.loads((skill / 'contracts/version.json').read_text()) == {
        'schema_version': 1,
        'contract_version': canonical_version,
        'canonical_owner': 'entregar-issue',
        'generated_copy': True,
    }
    assert digest(skill / 'schemas/subskill-result.schema.json') == digest(canonical / 'subskill-result.schema.json')
    assert digest(skill / 'contracts/subskill-result.schema.json') == digest(canonical / 'subskill-result.schema.json')
    assert json.loads((skill / 'contracts/manifest.json').read_text()) == json.loads((canonical / 'manifest.json').read_text())
    assert f'contract_version={canonical_version}' in (skill / 'SKILL.md').read_text()
    assert f'contract_version={canonical_version}' in (skill / 'references/delivery-contract.md').read_text()
