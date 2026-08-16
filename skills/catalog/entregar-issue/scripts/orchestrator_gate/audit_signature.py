from __future__ import annotations

import base64
import fnmatch
import hashlib
import json
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
except Exception as exc:  # pragma: no cover - environment-specific dependency failure
    InvalidSignature = Exception  # type: ignore[assignment]
    serialization = None  # type: ignore[assignment]
    Ed25519PublicKey = None  # type: ignore[assignment]
    _CRYPTO_IMPORT_ERROR = str(exc)
else:
    _CRYPTO_IMPORT_ERROR = ""


def canonical_report_bytes(report: dict[str, Any]) -> bytes:
    payload = deepcopy(report)
    payload.pop("signature", None)
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_registry(path: Path) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    if not path.is_file() or path.stat().st_size == 0:
        return {}, [f"trusted auditor registry is missing or empty: {path}"]
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {}, [f"trusted auditor registry is invalid JSON: {exc}"]
    if not isinstance(value, dict):
        return {}, ["trusted auditor registry must be an object"]
    if value.get("schema_version") != 1:
        errors.append("trusted auditor registry schema_version must be 1")
    auditors = value.get("auditors")
    if not isinstance(auditors, list) or not auditors:
        errors.append("trusted auditor registry must contain auditors")
        auditors = []
    seen: set[str] = set()
    for index, auditor in enumerate(auditors):
        if not isinstance(auditor, dict):
            errors.append(f"trusted auditor[{index}] must be an object")
            continue
        key_id = auditor.get("key_id")
        if not isinstance(key_id, str) or len(key_id.strip()) < 4:
            errors.append(f"trusted auditor[{index}].key_id is required")
            continue
        if key_id in seen:
            errors.append(f"duplicate trusted auditor key_id: {key_id}")
        seen.add(key_id)
        if auditor.get("enabled") is not True:
            errors.append(f"trusted auditor {key_id} must be explicitly enabled")
        if not isinstance(auditor.get("name"), str) or len(str(auditor.get("name")).strip()) < 3:
            errors.append(f"trusted auditor {key_id}.name is required")
        repositories = auditor.get("repositories")
        if not isinstance(repositories, list) or not repositories or any(
            not isinstance(item, str) or not item.strip() for item in repositories
        ):
            errors.append(f"trusted auditor {key_id}.repositories must be a non-empty string list")
        public_key = auditor.get("public_key_pem")
        if not isinstance(public_key, str) or "BEGIN PUBLIC KEY" not in public_key:
            errors.append(f"trusted auditor {key_id}.public_key_pem is required")
    return value, errors


def _repository_allowed(patterns: list[str], repository: str) -> bool:
    return any(pattern == "*" or fnmatch.fnmatchcase(repository, pattern) for pattern in patterns)


def verify_report_signature(
    report: dict[str, Any],
    registry: dict[str, Any],
    repository: str,
) -> tuple[list[str], dict[str, Any] | None]:
    errors: list[str] = []
    if _CRYPTO_IMPORT_ERROR or serialization is None or Ed25519PublicKey is None:
        return [f"Ed25519 verification is unavailable: {_CRYPTO_IMPORT_ERROR}"], None
    signature = report.get("signature")
    if not isinstance(signature, dict):
        return ["external audit report signature is required"], None
    if signature.get("algorithm") != "ed25519":
        errors.append("external audit signature algorithm must be ed25519")
    key_id = signature.get("key_id")
    if not isinstance(key_id, str) or not key_id.strip():
        errors.append("external audit signature key_id is required")
        return errors, None
    auditors = registry.get("auditors") or []
    auditor = next(
        (
            item
            for item in auditors
            if isinstance(item, dict)
            and item.get("key_id") == key_id
            and item.get("enabled") is True
        ),
        None,
    )
    if not isinstance(auditor, dict):
        errors.append(f"external audit key is not trusted: {key_id}")
        return errors, None
    patterns = auditor.get("repositories") or []
    if not _repository_allowed([str(item) for item in patterns], repository):
        errors.append(f"trusted auditor {key_id} is not authorized for repository {repository}")
    canonical = canonical_report_bytes(report)
    expected_payload_hash = sha256_bytes(canonical)
    if signature.get("signed_payload_sha256") != expected_payload_hash:
        errors.append("external audit signed_payload_sha256 does not match canonical report")
    raw_signature = signature.get("value_base64")
    if not isinstance(raw_signature, str) or not raw_signature.strip():
        errors.append("external audit signature value_base64 is required")
        return errors, auditor
    try:
        signature_bytes = base64.b64decode(raw_signature, validate=True)
    except Exception:
        errors.append("external audit signature is not valid base64")
        return errors, auditor
    try:
        public_key = serialization.load_pem_public_key(str(auditor.get("public_key_pem")).encode("utf-8"))
        if not isinstance(public_key, Ed25519PublicKey):
            errors.append("trusted auditor public key must be Ed25519")
        else:
            public_key.verify(signature_bytes, canonical)
    except InvalidSignature:
        errors.append("external audit signature verification failed")
    except Exception as exc:
        errors.append(f"trusted auditor public key is invalid: {exc}")
    fingerprint = auditor.get("public_key_sha256")
    if isinstance(fingerprint, str) and fingerprint:
        actual = sha256_bytes(str(auditor.get("public_key_pem")).encode("utf-8"))
        if fingerprint != actual:
            errors.append("trusted auditor public_key_sha256 does not match public_key_pem")
    return errors, auditor


def validate_registry_boundary(
    registry_path: Path,
    *,
    repository_path: Path | None,
    base_sha: str,
    head_sha: str,
) -> list[str]:
    """Prevent the implementation diff from silently trusting its own signing key."""
    errors: list[str] = []
    if repository_path is None:
        return errors
    try:
        relative = registry_path.resolve().relative_to(repository_path.resolve()).as_posix()
    except ValueError:
        # An external registry is an explicit trust boundary controlled outside the PR.
        return errors
    if not (repository_path / ".git").exists():
        return ["trusted auditor registry is inside a path that is not an exact Git repository"]
    proc = subprocess.run(
        ["git", "diff", "--quiet", f"{base_sha}...{head_sha}", "--", relative],
        cwd=repository_path,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode == 1:
        errors.append("trusted auditor registry was changed by the implementation diff")
    elif proc.returncode != 0:
        errors.append(proc.stderr.strip() or "cannot verify trusted auditor registry against base/head")
    show = subprocess.run(
        ["git", "show", f"{base_sha}:{relative}"],
        cwd=repository_path,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if show.returncode != 0:
        errors.append("trusted auditor registry did not exist in the frozen base SHA")
    elif sha256_bytes(show.stdout) != sha256_file(registry_path):
        errors.append("trusted auditor registry differs from the frozen base SHA")
    return errors
