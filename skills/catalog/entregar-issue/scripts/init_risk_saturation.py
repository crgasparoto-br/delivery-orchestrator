#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path

CANONICAL = [
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
]

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--attack-matrix", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    matrix = json.loads(Path(a.attack_matrix).read_text(encoding="utf-8"))
    active = set()
    controls_by_family: dict[str, set[str]] = {}
    for item in matrix.get("requirements") or []:
        families = {str(v) for v in item.get("risk_families") or []}
        active.update(families)
        ids = {str(c.get("id")) for c in item.get("negative_controls") or [] if isinstance(c, dict) and c.get("id")}
        for family in families:
            controls_by_family.setdefault(family, set()).update(ids)
    families = []
    for family in CANONICAL:
        applicable = family in active
        families.append({
            "family": family,
            "applicable": applicable,
            "reason": "Derived from requirement attack matrix." if applicable else "No current contract or diff signal requires this family.",
            "control_ids": sorted(controls_by_family.get(family, set())),
            "status": "pending" if applicable else "not-applicable",
        })
    out = {
        "schema_version": 1,
        "head_sha": matrix.get("head_sha"),
        "families": families,
        "material_families_missing_controls": [],
    }
    path = Path(a.out); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(path)
    return 0
if __name__ == "__main__": raise SystemExit(main())
