#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

FLAG_FAMILIES = {
    "isolation": {"tenant-isolation"},
    "temporal": {"temporal-consistency"},
    "temporal-destination": {"temporal-destination"},
    "freshness": {"reference-liveness"},
    "reference-liveness": {"reference-liveness"},
    "atomicity": {"concurrency-atomicity"},
    "structural": {"structural-contract"},
    "forbidden-implementation": {"structural-contract"},
    "canonical-path": {"structural-contract"},
    "precedence": {"structural-contract"},
}

TEXT_FAMILIES = (
    (re.compile(r"\b(permiss[aã]o|autoriz\w*|entitlement|perfil)\b", re.I), "authorization"),
    (re.compile(r"\b(outro tenant|cross-tenant|mesmo contrato|dataScope|escopo)\b", re.I), "tenant-isolation"),
    (re.compile(r"\b(n[aã]o revelar|n[aã]o enumera|404 gen[eé]ric|payload p[uú]blico|fronteira p[uú]blica)\b", re.I), "public-boundary"),
    (re.compile(r"\b(idempot\w*|retry|repetir exatamente|segunda libera[cç][aã]o)\b", re.I), "idempotency"),
    (re.compile(r"\b(concorr[eê]ncia|concorrentes?|serializ|for update|lock)\b", re.I), "concurrency-atomicity"),
    (re.compile(r"\b(rollback|estado parcial|transa[cç][aã]o)\b", re.I), "rollback"),
    (re.compile(r"\b(hist[oó]ric|imut[aá]vel|nova revis[aã]o|vers[aã]o anterior)\b", re.I), "historical-immutability"),
    (re.compile(r"\b(documenta[cç][aã]o|readme|adr|runbook)\b", re.I), "documentation"),
    (re.compile(r"\b(futuro|passad[oa]|semana|per[ií]odo|vig[eê]ncia|data alvo|workoutdate|weekstartdate)\b", re.I), "temporal-destination"),
    (re.compile(r"\b(continua(?:m)? (?:v[aá]lid|acess[ií]vel)|revalid\w*|no momento d[aeo]|ap[oó]s aprova[cç][aã]o|antes de liberar|refer[eê]ncias? obrigat[oó]rias?)\b", re.I), "reference-liveness"),
)


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit("requirement closure must be a JSON object")
    return value


def derive_families(obligation: dict) -> list[str]:
    families: set[str] = set()
    for flag in obligation.get("flags") or []:
        families.update(FLAG_FAMILIES.get(str(flag), set()))
    text = str(obligation.get("source_text") or "")
    for pattern, family in TEXT_FAMILIES:
        if pattern.search(text):
            families.add(family)
    if not families:
        families.add("semantic-effect")
    return sorted(families)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--requirement-closure", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    closure = load(Path(args.requirement_closure))
    by_requirement: dict[str, dict] = {}
    for obligation in closure.get("obligations") or []:
        if not isinstance(obligation, dict) or obligation.get("disposition") == "not-applicable":
            continue
        for requirement_id in obligation.get("requirement_ids") or []:
            rid = str(requirement_id)
            entry = by_requirement.setdefault(rid, {
                "requirement_id": rid,
                "obligation_ids": [],
                "risk_families": set(),
                "plausible_wrong_implementation": "",
                "positive_control": None,
                "negative_controls": [],
                "regression_controls": [],
            })
            entry["obligation_ids"].append(str(obligation.get("id")))
            entry["risk_families"].update(derive_families(obligation))

    requirements = []
    for rid in sorted(by_requirement):
        item = by_requirement[rid]
        item["obligation_ids"] = sorted(set(item["obligation_ids"]))
        item["risk_families"] = sorted(item["risk_families"])
        requirements.append(item)

    output = {
        "schema_version": 1,
        "head_sha": args.head_sha,
        "requirements": requirements,
        "uncovered_requirements": [],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
