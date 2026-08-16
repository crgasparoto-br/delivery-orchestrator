#!/usr/bin/env python3
"""Record findings and independently verifiable audit outcomes in orchestration-state.json."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import jsonschema

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from orchestrator_gate.audit_signature import (
    load_registry,
    sha256_file as registry_sha256,
    validate_registry_boundary,
    verify_report_signature,
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def transition(data: dict[str, Any], target: str, reason: str, timestamp: str) -> None:
    current = data.get("state")
    if current == target:
        return
    data.setdefault("transitions", []).append({
        "at": timestamp,
        "from": current,
        "to": target,
        "reason": reason,
        "head_sha": data.get("head_sha"),
        "base_sha": data.get("base_sha"),
        "merge_preview_sha": data.get("merge_preview_sha"),
        "identity_changed": False,
    })
    data["state"] = target


def invalidate_current_audit(data: dict[str, Any], reason: str, timestamp: str) -> None:
    external = data.get("external_audit")
    if isinstance(external, dict):
        data.setdefault("invalidated_audits", []).append({
            **external,
            "invalidated_at": timestamp,
            "invalidation_reason": reason,
        })
        data["external_audit"] = None


def validate_audit_report(report: dict[str, Any], data: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    validator = jsonschema.Draft202012Validator(schema)
    for item in sorted(validator.iter_errors(report), key=lambda err: list(err.path)):
        location = ".".join(str(value) for value in item.path) or "root"
        errors.append(f"audit report schema {location}: {item.message}")
    if errors:
        return errors
    try:
        issued_at = parse_time(str(report.get("issued_at")))
    except Exception:
        errors.append("audit report issued_at is invalid")
        return errors
    if report.get("repository") != data.get("repository"):
        errors.append("audit repository differs from orchestration state")
    if report.get("issue") != data.get("issue"):
        errors.append("audit issue differs from orchestration state")
    if report.get("base_ref") != data.get("base_ref"):
        errors.append("audit base_ref differs from orchestration state")
    for field in ("head_sha", "base_sha", "merge_preview_sha"):
        if report.get(field) != data.get(field):
            errors.append(f"audit {field} differs from orchestration state")
        if report.get(f"{field}_after") != report.get(field):
            errors.append(f"audit {field}_after differs from its frozen value")
    if report.get("orchestration_cycle") != data.get("controller_cycle", data.get("cycle")):
        errors.append("audit orchestration_cycle differs from current cycle")
    implementation_context = str(data.get("implementation_context_id") or "")
    if report.get("implementation_context_id") != implementation_context:
        errors.append("audit implementation_context_id differs from orchestration state")
    audit_context = str(report.get("audit_context_id") or "")
    if not audit_context or audit_context == implementation_context:
        errors.append("audit context must be present and different from implementation context")
    proof = report.get("source_context_proof") or {}
    if proof.get("value") != audit_context:
        errors.append("source context proof must match audit_context_id")
    if report.get("same_conversation") is not False or report.get("independent") is not True:
        errors.append("audit report does not prove a separate independent context")
    ready_times = [
        parse_time(str(item.get("at")))
        for item in data.get("transitions") or []
        if isinstance(item, dict) and item.get("to") == "pronto-para-auditoria-independente" and item.get("at")
    ]
    if report.get("verdict") in {"approved", "approved-with-reservations"}:
        if data.get("state") != "pronto-para-auditoria-independente":
            errors.append("approval can only be imported from pronto-para-auditoria-independente")
        if not ready_times or issued_at <= max(ready_times):
            errors.append("audit report must be issued after the current ready-for-audit handoff")
    prior_times: list[datetime] = []
    prior_report_ids: set[str] = set()
    prior_context_ids: set[str] = set()
    for item in data.get("audit_history") or []:
        if not isinstance(item, dict):
            continue
        if item.get("issued_at"):
            try:
                prior_times.append(parse_time(str(item["issued_at"])))
            except Exception:
                pass
        if isinstance(item.get("report_id"), str):
            prior_report_ids.add(str(item["report_id"]))
        if isinstance(item.get("audit_context_id"), str):
            prior_context_ids.add(str(item["audit_context_id"]))
    if prior_times and issued_at <= max(prior_times):
        errors.append("audit report is older than or equal to an already imported report")
    if str(report.get("report_id")) in prior_report_ids:
        errors.append("audit report_id was already imported")
    if audit_context in prior_context_ids:
        errors.append("audit context was already used by an imported report")
    try:
        signed_at = parse_time(str((report.get("signature") or {}).get("signed_at")))
        if signed_at < issued_at:
            errors.append("audit signature predates the report issuance")
    except Exception:
        errors.append("audit signature signed_at is invalid")
    if report.get("verdict") == "approved":
        if report.get("findings"):
            errors.append("approved audit report cannot contain findings")
        if report.get("limitations"):
            errors.append("approved audit report cannot contain unresolved limitations")
        if any(
            isinstance(item, dict) and item.get("status") != "resolved-and-reverified"
            for item in data.get("findings") or []
        ):
            errors.append("orchestration state contains unresolved findings")
        required_artifacts = {"packet-manifest", "pass-b-plan", "remote-gate"}
        if not required_artifacts.issubset(set((data.get("current_artifacts") or {}).keys())):
            errors.append("orchestration state lacks the current gate artifacts")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("state_file")
    sub = parser.add_subparsers(dest="action", required=True)

    add = sub.add_parser("add-finding")
    add.add_argument("--id", required=True)
    add.add_argument("--requirement", action="append", default=[])
    add.add_argument("--severity", required=True, choices=["blocker", "high", "medium", "low"])
    add.add_argument("--escape-class", required=True)
    add.add_argument("--generalized-invariant", required=True)
    add.add_argument("--evidence", action="append", default=[])

    resolve = sub.add_parser("resolve-finding")
    resolve.add_argument("--id", required=True)
    resolve.add_argument("--literal-scenario", action="append", default=[])
    resolve.add_argument("--sibling-scenario", action="append", default=[])
    resolve.add_argument("--evidence", action="append", default=[])

    audit = sub.add_parser("import-audit")
    audit.add_argument("--report-path", required=True)
    audit.add_argument(
        "--trusted-auditors",
        required=True,
        help="Trusted Ed25519 auditor registry. If stored in the repository, it must exist unchanged in the frozen base SHA.",
    )

    args = parser.parse_args()
    path = Path(args.state_file).resolve()
    if not path.is_file():
        print("error: state file not found", file=sys.stderr)
        return 2
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 3:
        print("error: unsupported state schema", file=sys.stderr)
        return 2
    timestamp = now()
    findings = data.setdefault("findings", [])
    if args.action == "add-finding":
        if any(isinstance(item, dict) and item.get("id") == args.id for item in findings):
            print(f"error: finding already exists: {args.id}", file=sys.stderr)
            return 2
        if len(args.generalized_invariant.strip()) < 30 or not args.evidence:
            print("error: generalized invariant (30+ chars) and evidence are required", file=sys.stderr)
            return 2
        findings.append({
            "id": args.id,
            "status": "open",
            "requirement_ids": args.requirement,
            "severity": args.severity,
            "escape_class": args.escape_class,
            "generalized_invariant": args.generalized_invariant,
            "evidence": args.evidence,
            "literal_scenarios": [],
            "sibling_scenarios": [],
            "created_at": timestamp,
        })
        invalidate_current_audit(data, f"later finding {args.id}", timestamp)
        transition(data, "em-correcao", f"finding {args.id} imported", timestamp)
    elif args.action == "resolve-finding":
        target = next((item for item in findings if isinstance(item, dict) and item.get("id") == args.id), None)
        if target is None:
            print(f"error: finding not found: {args.id}", file=sys.stderr)
            return 2
        if not args.literal_scenario or len(set(args.sibling_scenario)) < 2 or not args.evidence:
            print("error: resolution requires a literal scenario, two sibling scenarios and evidence", file=sys.stderr)
            return 2
        target.update({
            "status": "resolved-and-reverified",
            "literal_scenarios": args.literal_scenario,
            "sibling_scenarios": args.sibling_scenario,
            "resolution_evidence": args.evidence,
            "resolved_at": timestamp,
        })
    elif args.action == "import-audit":
        report_path = Path(args.report_path).resolve()
        if not report_path.is_file() or report_path.stat().st_size == 0:
            print("error: audit report missing or empty", file=sys.stderr)
            return 2
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
            schema_path = Path(__file__).resolve().parents[1] / "schemas" / "external-audit.schema.json"
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"error: invalid audit report or schema: {exc}", file=sys.stderr)
            return 2
        if not isinstance(report, dict):
            print("error: audit report must be a JSON object", file=sys.stderr)
            return 2
        report_errors = validate_audit_report(report, data, schema)
        registry_path = Path(args.trusted_auditors).resolve()
        registry, registry_errors = load_registry(registry_path)
        try:
            registry_schema_path = Path(__file__).resolve().parents[1] / "schemas" / "trusted-auditors.schema.json"
            registry_schema = json.loads(registry_schema_path.read_text(encoding="utf-8"))
            registry_validator = jsonschema.Draft202012Validator(registry_schema)
            for item in sorted(registry_validator.iter_errors(registry), key=lambda err: list(err.path)):
                location = ".".join(str(value) for value in item.path) or "root"
                registry_errors.append(f"trusted auditor registry schema {location}: {item.message}")
        except Exception as exc:
            registry_errors.append(f"cannot validate trusted auditor registry schema: {exc}")
        repository_path_raw = data.get("repository_path")
        repository_path = Path(str(repository_path_raw)).resolve() if repository_path_raw else None
        registry_errors.extend(validate_registry_boundary(
            registry_path,
            repository_path=repository_path,
            base_sha=str(data.get("base_sha") or ""),
            head_sha=str(data.get("head_sha") or ""),
        ))
        signature_errors, trusted_auditor = verify_report_signature(
            report, registry, str(data.get("repository") or "")
        )
        report_errors.extend(registry_errors)
        report_errors.extend(signature_errors)
        if report_errors:
            for error in report_errors:
                print(f"error: {error}", file=sys.stderr)
            return 2
        invalidate_current_audit(data, "superseded by a newer independent audit", timestamp)
        record = {
            "report_id": report.get("report_id"),
            "source": report.get("origin"),
            "source_sha": report.get("head_sha"),
            "result": report.get("verdict"),
            "independent": True,
            "same_conversation": False,
            "audit_context_id": report.get("audit_context_id"),
            "implementation_context_id": report.get("implementation_context_id"),
            "source_context_proof": report.get("source_context_proof"),
            "signature": report.get("signature"),
            "trusted_auditor": {
                "key_id": (trusted_auditor or {}).get("key_id"),
                "name": (trusted_auditor or {}).get("name"),
            },
            "trusted_auditors_path": str(registry_path),
            "trusted_auditors_sha256": registry_sha256(registry_path),
            "report_path": str(report_path),
            "report_sha256": sha256(report_path),
            "issued_at": report.get("issued_at"),
            "imported_at": timestamp,
            "orchestration_cycle": report.get("orchestration_cycle"),
            "head_sha": report.get("head_sha"),
            "base_sha": report.get("base_sha"),
            "merge_preview_sha": report.get("merge_preview_sha"),
            "findings": report.get("findings"),
            "limitations": report.get("limitations"),
        }
        data.setdefault("audit_history", []).append(record)
        data["external_audit"] = record
        if report.get("verdict") == "approved":
            transition(data, "aprovado", "valid independent audit imported", timestamp)
        else:
            transition(data, "em-correcao", f"independent audit result: {report.get('verdict')}", timestamp)
    data["updated_at"] = timestamp
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
