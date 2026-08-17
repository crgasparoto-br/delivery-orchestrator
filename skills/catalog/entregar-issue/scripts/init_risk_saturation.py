#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path

CANONICAL = [
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
]


def iter_surfaces(item: dict):
    families = {str(v) for v in item.get("risk_families") or []}
    for entry in item.get("risk_surfaces") or []:
        if isinstance(entry, str) and len(families) == 1:
            yield next(iter(families)), entry, "Derived from requirement attack matrix."
        elif isinstance(entry, dict):
            family = str(entry.get("risk_family") or entry.get("family") or "")
            surface = str(entry.get("surface") or "")
            reason = str(entry.get("reason") or "Derived from requirement attack matrix.")
            if family and surface:
                yield family, surface, reason


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--attack-matrix", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    matrix = json.loads(Path(a.attack_matrix).read_text(encoding="utf-8"))
    active = set()
    surfaces_by_family: dict[str, dict[str, str]] = {}
    controls_by_surface: dict[tuple[str, str], set[str]] = {}
    for item in matrix.get("requirements") or []:
        families = {str(v) for v in item.get("risk_families") or []}
        active.update(families)
        for family, surface, reason in iter_surfaces(item):
            surfaces_by_family.setdefault(family, {})[surface] = reason
        for control in item.get("negative_controls") or []:
            if not isinstance(control, dict) or not control.get("id"):
                continue
            family = str(control.get("risk_family") or "")
            surface = str(control.get("surface") or "")
            if family and surface:
                controls_by_surface.setdefault((family, surface), set()).add(str(control["id"]))

    families = []
    for family in CANONICAL:
        applicable = family in active
        dimensions = []
        for surface, reason in sorted(surfaces_by_family.get(family, {}).items()):
            dimensions.append({
                "surface": surface,
                "reason": reason,
                "control_ids": sorted(controls_by_surface.get((family, surface), set())),
                "status": "pending",
            })
        control_ids = sorted({cid for d in dimensions for cid in d["control_ids"]})
        families.append({
            "family": family,
            "applicable": applicable,
            "reason": "Derived from requirement attack matrix." if applicable else "No current contract or diff signal requires this family.",
            "control_ids": control_ids,
            "dimensions": dimensions,
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
