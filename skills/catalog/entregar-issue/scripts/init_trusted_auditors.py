#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a trusted auditor registry from an externally controlled Ed25519 public key.")
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--repository", action="append", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    public_path = Path(args.public_key).resolve()
    out = Path(args.out).resolve()
    if out.exists():
        print("error: refusing to overwrite an existing trusted auditor registry", file=sys.stderr)
        return 2
    try:
        pem = public_path.read_bytes()
        key = serialization.load_pem_public_key(pem)
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError("public key must be Ed25519")
    except Exception as exc:
        print(f"error: invalid public key: {exc}", file=sys.stderr)
        return 2
    value = {
        "schema_version": 1,
        "auditors": [{
            "key_id": args.key_id,
            "name": args.name,
            "enabled": True,
            "repositories": args.repository,
            "public_key_pem": pem.decode("utf-8"),
            "public_key_sha256": hashlib.sha256(pem).hexdigest(),
        }],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
