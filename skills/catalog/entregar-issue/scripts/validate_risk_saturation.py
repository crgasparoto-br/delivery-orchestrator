#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path

CANONICAL = {
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
}

def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict): raise SystemExit(f"expected object: {path}")
    return value

def main() -> int:
    p = argparse.ArgumentParser(); p.add_argument("--attack-matrix", required=True); p.add_argument("--risk-saturation", required=True); a=p.parse_args()
    matrix=load(Path(a.attack_matrix)); saturation=load(Path(a.risk_saturation)); errors=[]
    if saturation.get("schema_version") != 1: errors.append("risk saturation schema_version must be 1")
    if saturation.get("head_sha") != matrix.get("head_sha"): errors.append("risk saturation head_sha differs from attack matrix")
    entries={str(i.get("family")):i for i in saturation.get("families") or [] if isinstance(i,dict)}
    missing_canonical=sorted(CANONICAL-set(entries))
    if missing_canonical: errors.append(f"risk saturation omits canonical families: {missing_canonical}")
    active=set(); matrix_control_ids=set()
    for item in matrix.get("requirements") or []:
        active.update(str(v) for v in item.get("risk_families") or [])
        matrix_control_ids.update(str(c.get("id")) for c in item.get("negative_controls") or [] if isinstance(c,dict) and c.get("id"))
    for family in sorted(CANONICAL):
        item=entries.get(family)
        if not item: continue
        expected=family in active
        if bool(item.get("applicable")) != expected: errors.append(f"family {family} applicability differs from attack matrix")
        if expected:
            if item.get("status") != "passed": errors.append(f"family {family} is applicable but not passed")
            ids=[str(v) for v in item.get("control_ids") or []]
            if not ids: errors.append(f"family {family} has no control_ids")
            unknown=sorted(set(ids)-matrix_control_ids)
            if unknown: errors.append(f"family {family} references unknown controls: {unknown}")
        elif item.get("status") not in {"not-applicable", "passed"}: errors.append(f"family {family} non-applicable status is invalid")
        if len(str(item.get("reason") or "").strip()) < 8: errors.append(f"family {family} lacks applicability reason")
    if saturation.get("material_families_missing_controls"): errors.append("material_families_missing_controls is not empty")
    if errors:
        for e in errors: print(f"BLOCK: {e}")
        return 2
    print("READY: canonical risk families are explicitly saturated")
    return 0
if __name__ == "__main__": raise SystemExit(main())
