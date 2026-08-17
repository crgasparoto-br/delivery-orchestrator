#!/usr/bin/env python3
"""Cheap preflight: reject a delivery packet that has not saturated requirements and risk families."""
from __future__ import annotations
import argparse, json
from pathlib import Path

CANONICAL = {
    "authorization", "tenant-isolation", "public-boundary", "reference-liveness",
    "temporal-consistency", "temporal-destination", "concurrency-atomicity",
    "idempotency", "rollback", "historical-immutability", "structural-contract", "documentation",
}

def load(path: Path) -> dict:
    if not path.is_file(): raise FileNotFoundError(path)
    value=json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value,dict): raise ValueError(f"expected object: {path}")
    return value

def main() -> int:
    p=argparse.ArgumentParser(); p.add_argument("--attack-matrix",required=True); p.add_argument("--risk-saturation",required=True); p.add_argument("--inherited-controls",required=True); p.add_argument("--head-sha",required=True); a=p.parse_args()
    errors=[]
    try: matrix=load(Path(a.attack_matrix)); risk=load(Path(a.risk_saturation)); inherited=load(Path(a.inherited_controls))
    except Exception as exc: print(f"BLOCK: {exc}"); return 2
    if matrix.get("head_sha") != a.head_sha: errors.append("attack matrix head_sha differs from candidate")
    if risk.get("head_sha") != a.head_sha: errors.append("risk saturation head_sha differs from candidate")
    if inherited.get("head_sha") != a.head_sha: errors.append("inherited controls head_sha differs from candidate")
    if matrix.get("uncovered_requirements"): errors.append("attack matrix has uncovered requirements")
    for item in matrix.get("requirements") or []:
        rid=item.get("requirement_id") if isinstance(item,dict) else "?"
        if not isinstance(item,dict): errors.append("invalid attack matrix entry"); continue
        if len(str(item.get("plausible_wrong_implementation") or "").strip()) < 20: errors.append(f"requirement {rid} lacks plausible wrong implementation")
        pc=item.get("positive_control")
        if not isinstance(pc,dict) or pc.get("status") != "passed" or pc.get("head_sha") != a.head_sha: errors.append(f"requirement {rid} positive control not passed on candidate")
        neg=item.get("negative_controls") or []
        if not neg: errors.append(f"requirement {rid} lacks negative controls")
        if any(not isinstance(c,dict) or c.get("status") != "passed" or c.get("head_sha") != a.head_sha for c in neg): errors.append(f"requirement {rid} has negative control not passed on candidate")
        reg=item.get("regression_controls") or []
        if not reg: errors.append(f"requirement {rid} lacks regression controls")
        if any(not isinstance(c,dict) or c.get("status") != "passed" or c.get("head_sha") != a.head_sha for c in reg): errors.append(f"requirement {rid} has regression control not passed on candidate")
    families={str(i.get("family")):i for i in risk.get("families") or [] if isinstance(i,dict)}
    missing=sorted(CANONICAL-set(families))
    if missing: errors.append(f"risk saturation omits canonical families: {missing}")
    for family,item in families.items():
        if item.get("applicable") is True and (item.get("status") != "passed" or not item.get("control_ids")): errors.append(f"risk family {family} is applicable but unsaturated")
    if risk.get("material_families_missing_controls"): errors.append("risk saturation reports missing material controls")
    if inherited.get("unresolved_controls"): errors.append("inherited controls unresolved")
    for item in inherited.get("controls") or []:
        cid=item.get("id") if isinstance(item,dict) else "?"
        if not isinstance(item,dict) or item.get("status") != "passed" or item.get("head_sha") != a.head_sha: errors.append(f"inherited control {cid} not passed on candidate")
    if errors:
        for e in errors: print(f"BLOCK: {e}")
        return 2
    print("READY: delivery packet is saturated enough to spend an independent audit")
    return 0
if __name__ == "__main__": raise SystemExit(main())
