#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import stat
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate an Ed25519 auditor keypair. Never commit or upload the private key.")
    parser.add_argument("--private-out", required=True)
    parser.add_argument("--public-out", required=True)
    parser.add_argument("--password-env", help="Environment variable containing the private-key encryption password")
    args = parser.parse_args()
    private_out = Path(args.private_out).resolve()
    public_out = Path(args.public_out).resolve()
    if private_out.exists() or public_out.exists():
        print("error: refusing to overwrite an existing key file", file=sys.stderr)
        return 2
    password = os.environ.get(args.password_env) if args.password_env else None
    if args.password_env and not password:
        print(f"error: environment variable is missing: {args.password_env}", file=sys.stderr)
        return 2
    encryption = serialization.BestAvailableEncryption(password.encode("utf-8")) if password else serialization.NoEncryption()
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        encryption,
    )
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    private_out.parent.mkdir(parents=True, exist_ok=True)
    public_out.parent.mkdir(parents=True, exist_ok=True)
    private_out.write_bytes(private_pem)
    os.chmod(private_out, stat.S_IRUSR | stat.S_IWUSR)
    public_out.write_bytes(public_pem)
    print(str(public_out))
    if not password:
        print("warning: the private key is unencrypted; keep it outside repositories and implementation contexts", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
