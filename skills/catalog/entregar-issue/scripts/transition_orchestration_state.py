#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ALLOWED = {
    "pendente": {"em-correcao", "bloqueado"},
    "em-correcao": {"verificado", "bloqueado"},
    "verificado": {"em-correcao", "pronto-para-auditoria-independente", "bloqueado"},
    "pronto-para-auditoria-independente": {"em-correcao", "bloqueado"},
    "bloqueado": {"em-correcao", "pendente"},
    "aprovado": {"em-correcao"},
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("state_file")
    parser.add_argument("--to", required=True, choices=sorted(ALLOWED))
    parser.add_argument("--reason", required=True)
    parser.add_argument("--head-sha")
    parser.add_argument("--base-sha")
    parser.add_argument("--merge-preview-sha")
    parser.add_argument("--controller-cycle", type=int)
    parser.add_argument("--controller-state-revision", type=int)
    parser.add_argument("--artifact", action="append", default=[], help="name=path")
    args = parser.parse_args()
    path = Path(args.state_file).resolve()
    if not path.is_file():
        print("error: state file not found", file=sys.stderr)
        return 2
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 3:
        print("error: unsupported state schema", file=sys.stderr)
        return 2
    current = data.get("state")
    if args.to == "aprovado":
        print("error: approved state can only be produced by importing a valid independent audit", file=sys.stderr)
        return 2
    if args.to != current and args.to not in ALLOWED.get(current, set()):
        print(f"error: invalid transition {current} -> {args.to}", file=sys.stderr)
        return 2
    old_identity = (data.get("head_sha"), data.get("base_sha"), data.get("merge_preview_sha"))
    new_identity = (
        args.head_sha or data.get("head_sha"),
        args.base_sha or data.get("base_sha"),
        args.merge_preview_sha if args.merge_preview_sha is not None else data.get("merge_preview_sha"),
    )
    identity_changed = old_identity != new_identity
    timestamp = now()
    if identity_changed or (current == "aprovado" and args.to != "aprovado"):
        external = data.get("external_audit")
        if isinstance(external, dict):
            data.setdefault("invalidated_audits", []).append({
                **external,
                "invalidated_at": timestamp,
                "invalidation_reason": args.reason,
            })
            data["external_audit"] = None
    if identity_changed:
        for name, item in list((data.get("current_artifacts") or {}).items()):
            data.setdefault("invalidated_artifacts", []).append({
                "name": name,
                **item,
                "invalidated_at": timestamp,
                "reason": args.reason,
            })
        data["current_artifacts"] = {}
        if data.get("cycle_authority") in {"entregar-issue", "issue-loop-engineer"} and data.get("controller_mode"):
            if args.controller_cycle is not None:
                data["controller_cycle"] = args.controller_cycle
                data["cycle"] = args.controller_cycle
            if args.controller_state_revision is not None:
                data["controller_state_revision"] = args.controller_state_revision
        else:
            data["cycle"] = int(data.get("cycle", 0)) + 1
            data["controller_cycle"] = data["cycle"]
        if args.to not in {"em-correcao", "pendente"}:
            print("error: SHA/base/merge-preview change requires state em-correcao or pendente", file=sys.stderr)
            return 2
    data["head_sha"], data["base_sha"], data["merge_preview_sha"] = new_identity
    for value in args.artifact:
        if "=" not in value:
            print(f"error: invalid artifact {value!r}", file=sys.stderr)
            return 2
        name, raw_path = value.split("=", 1)
        artifact_path = Path(raw_path).resolve()
        if not artifact_path.is_file() or artifact_path.stat().st_size == 0:
            print(f"error: artifact missing or empty: {artifact_path}", file=sys.stderr)
            return 2
        data.setdefault("current_artifacts", {})[name] = {
            "path": str(artifact_path),
            "sha256": sha256(artifact_path),
            "head_sha": new_identity[0],
            "base_sha": new_identity[1],
            "merge_preview_sha": new_identity[2],
            "cycle": int(data.get("controller_cycle", data.get("cycle", 1))),
            "registered_at": timestamp,
        }
    data.setdefault("transitions", []).append({
        "at": timestamp,
        "from": current,
        "to": args.to,
        "reason": args.reason,
        "head_sha": new_identity[0],
        "base_sha": new_identity[1],
        "merge_preview_sha": new_identity[2],
        "identity_changed": identity_changed,
    })
    data["state"] = args.to
    data["updated_at"] = timestamp
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
