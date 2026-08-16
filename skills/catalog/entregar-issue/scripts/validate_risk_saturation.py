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


def iter_surfaces(item: dict):
    families = {str(v) for v in item.get("risk_families") or []}
    for entry in item.get("risk_surfaces") or []:
        if isinstance(entry, str) and len(families) == 1:
            yield next(iter(families)), entry
        elif isinstance(entry, dict):
            family = str(entry.get("risk_family") or entry.get("family") or "")
            surface = str(entry.get("surface") or "")
            if family and surface:
                yield family, surface


def required_escape_dimensions(directory: Path, errors: list[str]) -> set[tuple[str, str, str]]:
    path = directory / "audit-escape-closure.json"
    if not path.is_file():
        return set()
    closure = load(path)
    entries = closure.get("escapes") if isinstance(closure.get("escapes"), list) else [closure]
    required: set[tuple[str, str, str]] = set()
    for index, escape in enumerate(entries):
        if not isinstance(escape, dict):
            errors.append(f"audit escape entry {index} is invalid")
            continue
        eid = str(escape.get("escape_id") or index)
        if escape.get("status") != "passed":
            continue
        families = {str(v) for v in escape.get("required_risk_families") or []}
        raw = escape.get("required_attack_dimensions") or []
        triples: set[tuple[str, str, str]] = set()
        for dindex, item in enumerate(raw):
            if not isinstance(item, dict):
                errors.append(f"audit escape {eid} required attack dimension {dindex} is invalid")
                continue
            family = str(item.get("risk_family") or "").strip()
            surface = str(item.get("surface") or "").strip()
            dimension = str(item.get("dimension") or "").strip()
            if family not in families:
                errors.append(f"audit escape {eid} required attack dimension {dindex} references non-required family {family or '?'}")
            if not surface or len(dimension) < 3:
                errors.append(f"audit escape {eid} required attack dimension {dindex} is incomplete")
            if family and surface and dimension:
                triples.add((family, surface, dimension))
        if len(triples) < 2:
            errors.append(f"audit escape {eid} must require at least two distinct attack dimensions")
        required.update(triples)
    return required


def main() -> int:
    p = argparse.ArgumentParser(); p.add_argument("--attack-matrix", required=True); p.add_argument("--risk-saturation", required=True); a=p.parse_args()
    attack_path=Path(a.attack_matrix)
    matrix=load(attack_path); saturation=load(Path(a.risk_saturation)); errors=[]
    if saturation.get("schema_version") != 1: errors.append("risk saturation schema_version must be 1")
    if saturation.get("head_sha") != matrix.get("head_sha"): errors.append("risk saturation head_sha differs from attack matrix")
    entries={str(i.get("family")):i for i in saturation.get("families") or [] if isinstance(i,dict)}
    missing_canonical=sorted(CANONICAL-set(entries))
    if missing_canonical: errors.append(f"risk saturation omits canonical families: {missing_canonical}")

    active=set()
    required_surfaces: dict[str, set[str]] = {}
    control_meta: dict[str, tuple[str, str]] = {}
    control_dimensions: set[tuple[str, str, str]] = set()
    for item in matrix.get("requirements") or []:
        active.update(str(v) for v in item.get("risk_families") or [])
        for family, surface in iter_surfaces(item):
            required_surfaces.setdefault(family, set()).add(surface)
        for control in item.get("negative_controls") or []:
            if not isinstance(control,dict) or not control.get("id"):
                continue
            family = str(control.get("risk_family") or "")
            surface = str(control.get("surface") or "")
            dimension = str(control.get("dimension") or "")
            cid = str(control["id"])
            control_meta[cid] = (family, surface)
            if family and surface and dimension:
                control_dimensions.add((family, surface, dimension))
            for sibling in control.get("sibling_cases") or []:
                if not isinstance(sibling, dict):
                    continue
                ssurface = str(sibling.get("surface") or "")
                sdimension = str(sibling.get("dimension") or "")
                if family and ssurface and sdimension:
                    control_dimensions.add((family, ssurface, sdimension))

    for family in sorted(CANONICAL):
        item=entries.get(family)
        if not item: continue
        expected=family in active
        if bool(item.get("applicable")) != expected: errors.append(f"family {family} applicability differs from attack matrix")
        if expected:
            if item.get("status") != "passed": errors.append(f"family {family} is applicable but not passed")
            ids=[str(v) for v in item.get("control_ids") or []]
            if not ids: errors.append(f"family {family} has no control_ids")
            unknown=sorted(set(ids)-set(control_meta))
            if unknown: errors.append(f"family {family} references unknown controls: {unknown}")

            dimensions = item.get("dimensions") or []
            by_surface = {str(d.get("surface")): d for d in dimensions if isinstance(d, dict) and d.get("surface")}
            required = required_surfaces.get(family, set())
            missing = sorted(required - set(by_surface))
            extra = sorted(set(by_surface) - required)
            if missing: errors.append(f"family {family} omits required surfaces: {missing}")
            if extra: errors.append(f"family {family} has undeclared surfaces: {extra}")
            if not required:
                errors.append(f"family {family} is applicable but requirement attack matrix declares no surfaces")
            for surface in sorted(required & set(by_surface)):
                dimension = by_surface[surface]
                if dimension.get("status") != "passed":
                    errors.append(f"family {family} surface {surface} is not passed")
                reason = str(dimension.get("reason") or "").strip()
                if len(reason) < 8:
                    errors.append(f"family {family} surface {surface} lacks reason")
                surface_ids = [str(v) for v in dimension.get("control_ids") or []]
                if not surface_ids:
                    errors.append(f"family {family} surface {surface} has no control_ids")
                for cid in surface_ids:
                    meta = control_meta.get(cid)
                    if not meta:
                        errors.append(f"family {family} surface {surface} references unknown control {cid}")
                    elif meta != (family, surface):
                        errors.append(f"family {family} surface {surface} references control {cid} for {meta[0]}:{meta[1]}")
                expected_ids = {cid for cid, meta in control_meta.items() if meta == (family, surface)}
                if expected_ids and not expected_ids.intersection(surface_ids):
                    errors.append(f"family {family} surface {surface} does not reference any matching adversarial control")
        elif item.get("status") not in {"not-applicable", "passed"}: errors.append(f"family {family} non-applicable status is invalid")
        if len(str(item.get("reason") or "").strip()) < 8: errors.append(f"family {family} lacks applicability reason")

    required_escape = required_escape_dimensions(attack_path.parent, errors)
    missing_escape = sorted(required_escape - control_dimensions)
    if missing_escape:
        rendered = [f"{family}:{surface}:{dimension}" for family, surface, dimension in missing_escape]
        errors.append(f"audit escape required attack dimensions are not covered: {rendered}")

    if saturation.get("material_families_missing_controls"): errors.append("material_families_missing_controls is not empty")
    if errors:
        for e in errors: print(f"BLOCK: {e}")
        return 2
    print("READY: canonical risk families, attack surfaces and audit-escape dimensions are saturated")
    return 0
if __name__ == "__main__": raise SystemExit(main())
