#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path

def main() -> int:
    p=argparse.ArgumentParser(); p.add_argument("--inherited-controls", required=True); p.add_argument("--head-sha", required=True); p.add_argument("--previous-independent-rejection", action="store_true"); a=p.parse_args()
    path=Path(a.inherited_controls)
    if not path.is_file(): print("BLOCK: inherited-controls.json is missing"); return 2
    data=json.loads(path.read_text(encoding="utf-8")); errors=[]
    if data.get("schema_version") != 1: errors.append("inherited controls schema_version must be 1")
    if data.get("head_sha") != a.head_sha: errors.append("inherited controls head_sha does not match candidate")
    controls=data.get("controls") or []
    if a.previous_independent_rejection and not controls: errors.append("previous independent rejection requires inherited controls")
    for idx,item in enumerate(controls):
        if not isinstance(item,dict): errors.append(f"inherited control {idx} is invalid"); continue
        cid=item.get("id") or idx
        if item.get("status") != "passed": errors.append(f"inherited control {cid} is not passed")
        if item.get("head_sha") != a.head_sha: errors.append(f"inherited control {cid} head_sha differs from candidate")
        if not str(item.get("evidence") or "").strip(): errors.append(f"inherited control {cid} lacks evidence")
    if data.get("unresolved_controls"): errors.append("inherited controls has unresolved_controls")
    if errors:
        for e in errors: print(f"BLOCK: {e}")
        return 2
    print("READY: cumulative inherited audit controls are closed")
    return 0
if __name__ == "__main__": raise SystemExit(main())
