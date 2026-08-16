from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEAD = "b" * 40
CANONICAL = [
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
]


def run(*args: str):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / "check_delivery_saturation.py"), *args], text=True, stdout=subprocess.PIPE)


def test_preflight_rejects_unsaturated_material_family() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        base=Path(tmp)
        matrix=base/"matrix.json"; risk=base/"risk.json"; inherited=base/"inherited.json"
        matrix.write_text(json.dumps({"head_sha":HEAD,"requirements":[{"requirement_id":"REQ-1","plausible_wrong_implementation":"Accept a past target because the date parses as ISO.","positive_control":{"status":"passed","head_sha":HEAD},"negative_controls":[{"status":"passed","head_sha":HEAD}],"regression_controls":[{"status":"passed","head_sha":HEAD}]}],"uncovered_requirements":[]}),encoding="utf-8")
        risk.write_text(json.dumps({"head_sha":HEAD,"families":[{"family":f,"applicable":f=="temporal-destination","status":"pending" if f=="temporal-destination" else "not-applicable","control_ids":[] if f=="temporal-destination" else []} for f in CANONICAL],"material_families_missing_controls":[]}),encoding="utf-8")
        inherited.write_text(json.dumps({"head_sha":HEAD,"controls":[],"unresolved_controls":[]}),encoding="utf-8")
        proc=run("--attack-matrix",str(matrix),"--risk-saturation",str(risk),"--inherited-controls",str(inherited),"--head-sha",HEAD)
        assert proc.returncode==2
        assert "temporal-destination" in proc.stdout


def test_blocker_harvest_contract_requires_all_atomic_requirements() -> None:
    text=(ROOT/"references"/"blocker-harvest.md").read_text(encoding="utf-8")
    skill=(ROOT/"SKILL.md").read_text(encoding="utf-8")
    assert "todos os requisitos atomicos" in text
    assert "causas diferentes" in skill
    assert "reference-liveness" in text
    assert "passado/atual/futuro" in text
