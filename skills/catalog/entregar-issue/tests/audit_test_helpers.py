from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def generate_keypair(private_path: Path, public_path: Path) -> None:
    key = Ed25519PrivateKey.generate()
    private_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    public_path.write_bytes(
        key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )


def write_registry(
    path: Path,
    public_key_path: Path,
    *,
    key_id: str = "auditor-key-1",
    repository: str = "owner/repo",
) -> None:
    public_pem = public_key_path.read_text(encoding="utf-8")
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "auditors": [
                    {
                        "key_id": key_id,
                        "name": "Independent Auditor",
                        "enabled": True,
                        "repositories": [repository],
                        "public_key_pem": public_pem,
                        "public_key_sha256": hashlib.sha256(public_pem.encode("utf-8")).hexdigest(),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def write_approved_report(
    path: Path,
    *,
    repository: str,
    issue: int,
    base_ref: str,
    head_sha: str,
    base_sha: str,
    merge_preview_sha: str,
    cycle: int,
    implementation_context_id: str,
    audit_context_id: str,
) -> dict[str, object]:
    issued_at = now()
    report: dict[str, object] = {
        "schema_version": 2,
        "report_id": str(uuid4()),
        "generated_by": "auditar-issue",
        "repository": repository,
        "issue": issue,
        "base_ref": base_ref,
        "head_sha": head_sha,
        "head_sha_after": head_sha,
        "base_sha": base_sha,
        "base_sha_after": base_sha,
        "merge_preview_sha": merge_preview_sha,
        "merge_preview_sha_after": merge_preview_sha,
        "orchestration_cycle": cycle,
        "implementation_context_id": implementation_context_id,
        "audit_context_id": audit_context_id,
        "source_context_proof": {
            "kind": "agent-run-id",
            "value": audit_context_id,
            "issuer": "independent-audit-runner",
            "issued_at": issued_at,
        },
        "same_conversation": False,
        "independent": True,
        "issued_at": issued_at,
        "verdict": "approved",
        "findings": [],
        "evidence": [
            {
                "id": "EV-AUD-1",
                "claim": "The final SHA and merge identity were independently checked.",
                "source": "independent audit execution log",
                "observed_at": issued_at,
            }
        ],
        "limitations": [],
        "origin": "Independent audit run in a separately authenticated context",
    }
    path.write_text(json.dumps(report), encoding="utf-8")
    return report


def canonical_report_bytes(report: dict[str, object]) -> bytes:
    payload = dict(report)
    payload.pop("signature", None)
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sign_report(path: Path, private_key_path: Path, *, key_id: str = "auditor-key-1") -> None:
    report = json.loads(path.read_text(encoding="utf-8"))
    report.pop("signature", None)
    canonical = canonical_report_bytes(report)
    key = serialization.load_pem_private_key(private_key_path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("test private key must be Ed25519")
    report["signature"] = {
        "algorithm": "ed25519",
        "key_id": key_id,
        "signed_payload_sha256": hashlib.sha256(canonical).hexdigest(),
        "value_base64": base64.b64encode(key.sign(canonical)).decode("ascii"),
        "signed_at": now(),
    }
    path.write_text(json.dumps(report), encoding="utf-8")
