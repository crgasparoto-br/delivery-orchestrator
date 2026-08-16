from __future__ import annotations

import base64
import fnmatch
import hashlib
import json
from copy import deepcopy
from datetime import datetime
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


def _parse_time(value: object, label: str, errors: list[str]) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        errors.append(f"{label} is not a valid ISO-8601 timestamp")
        return None


def report_semantic_errors(report: dict[str, Any], *, require_signature: bool) -> list[str]:
    errors: list[str] = []
    if report.get("audit_context_id") == report.get("implementation_context_id"):
        errors.append("audit context must differ from implementation context")
    proof = report.get("source_context_proof")
    if not isinstance(proof, dict):
        errors.append("source_context_proof is required")
        proof = {}
    if proof.get("value") != report.get("audit_context_id"):
        errors.append("source context proof must equal audit_context_id")
    for field in ("head_sha", "base_sha", "merge_preview_sha"):
        if report.get(field) != report.get(f"{field}_after"):
            errors.append(f"{field}_after must equal {field}")
    if report.get("verdict") == "approved" and (report.get("findings") or report.get("limitations")):
        errors.append("approved report cannot contain findings or limitations")
    packet = report.get("neutral_packet")
    if not isinstance(packet, dict):
        errors.append("neutral_packet is required")
    else:
        if packet.get("implementation_conclusions_included") is not False:
            errors.append("neutral packet must exclude implementation conclusions")
        if packet.get("implementation_narrative_included") is not False:
            errors.append("neutral packet must exclude implementation narrative")
    prior = report.get("prior_internal_approval")
    evidence = report.get("evidence") or []
    evidence_ids = [item.get("id") for item in evidence if isinstance(item, dict)]
    if len(evidence_ids) != len(set(evidence_ids)):
        errors.append("external audit evidence IDs must be unique")
    findings = report.get("findings") or []
    if isinstance(prior, dict) and prior.get("head_sha") == report.get("head_sha") and findings:
        for finding in findings:
            if not isinstance(finding, dict) or finding.get("audit_escape") is not True:
                errors.append("findings against a previously internally approved SHA must be audit escapes")
                break
            if not finding.get("reusable_control_requirement"):
                errors.append("audit escape finding requires reusable_control_requirement")
                break
    elif any(isinstance(finding, dict) and finding.get("audit_escape") is True for finding in findings):
        errors.append("audit_escape requires prior_internal_approval for the same head SHA")
    finding_ids = [item.get("id") for item in findings if isinstance(item, dict)]
    if len(finding_ids) != len(set(finding_ids)):
        errors.append("external audit finding IDs must be unique")
    issued_at = _parse_time(report.get("issued_at"), "issued_at", errors)
    proof_issued_at = _parse_time(proof.get("issued_at"), "source_context_proof.issued_at", errors)
    if issued_at and proof_issued_at and proof_issued_at > issued_at:
        errors.append("source context proof cannot be issued after the audit report")
    signature = report.get("signature")
    if require_signature and not isinstance(signature, dict):
        errors.append("signature is required")
    if isinstance(signature, dict):
        signed_at = _parse_time(signature.get("signed_at"), "signature.signed_at", errors)
        if issued_at and signed_at and signed_at < issued_at:
            errors.append("signature cannot predate the audit report")
    return errors


def canonical_report_bytes(report: dict[str, Any]) -> bytes:
    payload = deepcopy(report)
    payload.pop("signature", None)
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sign_report(report: dict[str, Any], private_key_pem: bytes, password: bytes | None, key_id: str, signed_at: str) -> None:
    private_key = serialization.load_pem_private_key(private_key_pem, password=password)
    if not isinstance(private_key, Ed25519PrivateKey):
        raise ValueError("private key must be Ed25519")
    canonical = canonical_report_bytes(report)
    signature = private_key.sign(canonical)
    report["signature"] = {
        "algorithm": "ed25519",
        "key_id": key_id,
        "signed_payload_sha256": sha256_bytes(canonical),
        "value_base64": base64.b64encode(signature).decode("ascii"),
        "signed_at": signed_at,
    }


def verify_report(report: dict[str, Any], registry: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    key_ids = [
        item.get("key_id")
        for item in registry.get("auditors", [])
        if isinstance(item, dict) and isinstance(item.get("key_id"), str)
    ]
    if len(key_ids) != len(set(key_ids)):
        errors.append("trusted auditor key IDs must be unique")
    signature = report.get("signature")
    if not isinstance(signature, dict):
        return ["signature is required"]
    key_id = signature.get("key_id")
    auditor = next((item for item in registry.get("auditors", []) if isinstance(item, dict) and item.get("key_id") == key_id and item.get("enabled") is True), None)
    if not isinstance(auditor, dict):
        return [f"untrusted auditor key: {key_id}"]
    repository = str(report.get("repository") or "")
    if not any(pattern == "*" or fnmatch.fnmatchcase(repository, str(pattern)) for pattern in auditor.get("repositories", [])):
        errors.append(f"auditor key is not authorized for repository {repository}")
    canonical = canonical_report_bytes(report)
    if signature.get("signed_payload_sha256") != sha256_bytes(canonical):
        errors.append("signed_payload_sha256 mismatch")
    try:
        raw = base64.b64decode(str(signature.get("value_base64") or ""), validate=True)
        public_key = serialization.load_pem_public_key(str(auditor.get("public_key_pem") or "").encode("utf-8"))
        if not isinstance(public_key, Ed25519PublicKey):
            errors.append("trusted public key must be Ed25519")
        else:
            public_key.verify(raw, canonical)
    except InvalidSignature:
        errors.append("signature verification failed")
    except Exception as exc:
        errors.append(f"invalid signature or public key: {exc}")
    expected_fingerprint = auditor.get("public_key_sha256")
    if expected_fingerprint != sha256_bytes(str(auditor.get("public_key_pem") or "").encode("utf-8")):
        errors.append("public key fingerprint mismatch")
    return errors
