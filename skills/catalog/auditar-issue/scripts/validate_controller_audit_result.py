#!/usr/bin/env python3
"""Validate the strict audit report used by Entregar Issue v5."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

import jsonschema


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    schema_path = Path(__file__).resolve().parents[1] / "schemas" / "controller-audit-result.schema.json"
    try:
        report = json.loads(args.report.read_text(encoding="utf-8"))
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(report)
        started = datetime.fromisoformat(report["started_at"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(report["finished_at"].replace("Z", "+00:00"))
        if finished < started:
            raise ValueError("finished_at precedes started_at")

        expected_scope = "independent-release-gate" if report["mode"] == "independent" else "internal-only"
        if report["approval_scope"] != expected_scope:
            raise ValueError("approval_scope is inconsistent with audit mode")
        packet = report["neutral_packet"]
        if packet["implementation_conclusions_included"] or packet["implementation_narrative_included"]:
            raise ValueError("neutral packet contains implementation conclusions or narrative")

        requirement_ids = [item["id"] for item in report["requirements"]]
        if len(requirement_ids) != len(set(requirement_ids)):
            raise ValueError("requirement ids must be unique")
        finding_ids = [item["id"] for item in report["findings"]]
        if len(finding_ids) != len(set(finding_ids)):
            raise ValueError("finding ids must be unique")

        open_blocking = [
            item for item in report["findings"]
            if item["status"] == "open" and item["disposition"] == "blocking"
        ]
        unresolved = [
            item for item in report["requirements"]
            if item["status"] not in {"Implementado", "Fora do escopo"}
            or (item["status"] == "Fora do escopo" and not item.get("scope_basis"))
        ]
        material_limits = [item for item in report["limitations"] if item["material"]]
        failed_gates = [item for item in report["gates"] if item["status"] != "passed"]
        if report["verdict"] == "Aprovado" and (open_blocking or unresolved or material_limits or failed_gates):
            raise ValueError("Aprovado is inconsistent with findings, requirements, limitations or gates")

        input_parser_controls = []
        for requirement in report["requirements"]:
            if requirement["status"] == "Implementado":
                if not requirement["evidence"] or not requirement["negative_controls"] or not requirement["regression_evidence"]:
                    raise ValueError(f"{requirement['id']} lacks positive, negative or regression evidence")
                evidence_by_id = {item["id"]: item for item in requirement["negative_control_evidence"]}
                if set(evidence_by_id) != set(requirement["negative_controls"]):
                    raise ValueError(f"{requirement['id']} negative control ids and evidence do not match exactly")
                for control_id in requirement["negative_controls"]:
                    control = evidence_by_id[control_id]
                    if control["status"] != "passed":
                        raise ValueError(f"{requirement['id']}/{control_id} negative control did not pass")
                    if control["head_sha"] != report["identity"]["head_sha"]:
                        raise ValueError(f"{requirement['id']}/{control_id} targets a different head SHA")
                    evidence_path = Path(control["evidence_path"])
                    if not evidence_path.is_absolute():
                        evidence_path = args.report.parent / evidence_path
                    if not evidence_path.is_file():
                        raise ValueError(f"{requirement['id']}/{control_id} evidence file does not exist")
                    if file_sha256(evidence_path) != control["evidence_sha256"]:
                        raise ValueError(f"{requirement['id']}/{control_id} evidence hash mismatch")
                    if control.get("risk_family") == "input-parser":
                        input_parser_controls.append(control)

        if input_parser_controls:
            required_control_ids = {
                "IP-RAW-001",
                "IP-MODE-001",
                "IP-SCOPE-001",
                "IP-INACTIVE-001",
                "IP-EFFECT-001",
            }
            required_dimensions = {
                "raw-boundary-preservation",
                "validation-order-error-precedence",
                "syntax-mode-invariant-matrix",
            }
            control_ids = {item.get("id") for item in input_parser_controls}
            dimensions = {item.get("dimension") for item in input_parser_controls}
            parser_errors = []
            missing_ids = sorted(required_control_ids - control_ids)
            if missing_ids:
                parser_errors.append(f"stable control ids: {missing_ids}")
            missing_dimensions = sorted(required_dimensions - dimensions)
            if missing_dimensions:
                parser_errors.append(f"mandatory dimensions: {missing_dimensions}")
            if parser_errors:
                raise ValueError("input-parser controls miss " + "; ".join(parser_errors))
            for control in input_parser_controls:
                siblings = {
                    item.strip() for item in control.get("sibling_cases", [])
                    if isinstance(item, str) and item.strip()
                }
                if len(siblings) < 2:
                    raise ValueError(
                        f"{control.get('id')} input-parser control requires at least two sibling cases"
                    )

        prior = report["prior_internal_approval"]
        escapes = report["audit_escapes"]
        if report["mode"] != "independent" and escapes:
            raise ValueError("audit escapes can only be declared by an independent audit")
        if report["mode"] == "independent" and prior and prior["head_sha"] == report["identity"]["head_sha"] and open_blocking:
            by_finding = {item["finding_id"]: item for item in escapes}
            for finding in open_blocking:
                escape = by_finding.get(finding["id"])
                if escape is None:
                    raise ValueError(f"{finding['id']} must be recorded as an audit escape")
                if escape["fingerprint"] != finding["fingerprint"]:
                    raise ValueError(f"{finding['id']} audit escape fingerprint mismatch")
                if escape["affected_head_sha"] != report["identity"]["head_sha"]:
                    raise ValueError(f"{finding['id']} audit escape SHA mismatch")
                if escape["prior_internal_report_sha256"] != prior["report_sha256"]:
                    raise ValueError(f"{finding['id']} audit escape prior report mismatch")
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print("PASS: audit result accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
