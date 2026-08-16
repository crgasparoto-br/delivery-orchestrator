#!/usr/bin/env python3
"""Build an immutable audit packet from a clean, exact Git checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from orchestrator_gate.risk_detection import detect as detect_risk
from orchestrator_gate.specification import load_snapshot, sha256_file as specification_sha256_file
from runtime_graph import build_runtime_context

TEST_MARKERS = ("/test/", "/tests/", "__tests__", ".test.", ".spec.", "test_", "_test.", "playwright", "cypress")
DOC_MARKERS = ("docs/", "documentation/", "readme", "changelog", ".md", ".mdx", "agents.md")


def run(cmd: list[str], cwd: Path, *, text: bool = True) -> str | bytes:
    proc = subprocess.run(cmd, cwd=cwd, text=text, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        stderr = proc.stderr.strip() if text else proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(cmd)}\n{stderr}")
    return proc.stdout


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def classify(path: str) -> str:
    normalized = path.replace("\\", "/")
    lower = normalized.lower()
    if any(marker in lower for marker in TEST_MARKERS):
        return "test"
    if any(lower.startswith(marker) or lower.endswith(marker) or marker in lower for marker in DOC_MARKERS):
        return "doc"
    return "production"


def discover_instruction_files(repo: Path) -> list[str]:
    result: set[str] = set()
    for name in ("AGENTS.md", "CONTRIBUTING.md"):
        for path in repo.rglob(name):
            if any(part in {".git", "node_modules", ".venv", "dist", "build"} for part in path.parts):
                continue
            result.add(path.relative_to(repo).as_posix())
    return sorted(result)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--issue-file", required=True)
    parser.add_argument("--specification-snapshot", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    issue_file = Path(args.issue_file).resolve()
    specification_snapshot = Path(args.specification_snapshot).resolve()
    out = Path(args.out).resolve()
    if not (repo / ".git").exists() or not issue_file.is_file() or not specification_snapshot.is_file():
        print("error: repository, issue file, or specification snapshot is invalid", file=sys.stderr)
        return 2
    specification_errors: list[str] = []
    _, specification_sources = load_snapshot(specification_snapshot, specification_errors)
    if specification_errors:
        print("error: " + "; ".join(specification_errors), file=sys.stderr)
        return 2
    try:
        head_sha = str(run(["git", "rev-parse", args.head], repo)).strip()
        current_head = str(run(["git", "rev-parse", "HEAD"], repo)).strip()
        base_sha = str(run(["git", "rev-parse", args.base], repo)).strip()
        merge_base = str(run(["git", "merge-base", args.base, args.head], repo)).strip()
        status = str(run(["git", "status", "--porcelain=v1"], repo))
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if head_sha != current_head:
        print("error: checkout HEAD must equal requested head SHA", file=sys.stderr)
        return 3
    if status.strip():
        print("error: repository is dirty; freeze a clean SHA first", file=sys.stderr)
        return 3

    changed_raw = str(run(["git", "diff", "--name-status", f"{args.base}...{args.head}"], repo))
    changed: list[dict[str, str]] = []
    for line in changed_raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        path = parts[-1]
        changed.append({"status": parts[0], "path": path, "class": classify(path)})

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copyfile(issue_file, out / "issue.md")
    shutil.copyfile(specification_snapshot, out / "specification-snapshot.json")
    for source in specification_sources.values():
        source_path = Path(str(source.get("resolved_path") or ""))
        rel = Path(str(source.get("path") or ""))
        if rel.is_absolute() or ".." in rel.parts:
            print(f"error: unsafe specification source path: {rel}", file=sys.stderr)
            return 2
        destination = out / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, destination)
    (out / "git_status.txt").write_text(status, encoding="utf-8")
    write_json(out / "changed_files.json", changed)

    groups = {
        kind: [item["path"] for item in changed if item["class"] == kind]
        for kind in ("production", "test", "doc")
    }
    for kind, filename in (("production", "production.patch"), ("test", "tests.patch"), ("doc", "docs.patch")):
        paths = groups[kind]
        content = "" if not paths else str(run(["git", "diff", "--binary", f"{args.base}...{args.head}", "--", *paths], repo))
        (out / filename).write_text(content, encoding="utf-8")

    deleted_production = [item["path"] for item in changed if item["class"] == "production" and str(item["status"]).startswith("D")]
    virtual_contents: dict[str, str] = {}
    for rel in deleted_production:
        try:
            payload = run(["git", "show", f"{args.base}:{rel}"], repo, text=False)
            if isinstance(payload, bytes) and b"\x00" not in payload:
                virtual_contents[rel] = payload.decode("utf-8", errors="replace")
        except RuntimeError:
            pass
    try:
        context_files, edges, unresolved, coverage = build_runtime_context(repo, groups["production"], virtual_contents)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 4
    for item in context_files:
        rel = str(item["path"])
        source = repo / rel
        destination = out / "production-context" / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_file():
            shutil.copyfile(source, destination)
            item["snapshot_ref"] = "head"
        elif rel in virtual_contents:
            destination.write_text(virtual_contents[rel], encoding="utf-8")
            item["snapshot_ref"] = "base"
            item["deleted"] = True
        else:
            continue
        item["sha256"] = sha256_file(destination)
        item["size"] = destination.stat().st_size
    write_json(out / "production_context_files.json", context_files)
    write_json(out / "dependency_edges.json", edges)
    write_json(out / "unresolved_local_imports.json", unresolved)
    write_json(out / "runtime_graph_coverage.json", coverage)

    risk = detect_risk(repo, [item["path"] for item in changed], (out / "production.patch").read_text(encoding="utf-8", errors="ignore"))
    write_json(out / "risk_detection.json", risk)

    instruction_files = discover_instruction_files(repo)
    write_json(out / "instruction_files.json", instruction_files)
    for rel in instruction_files:
        destination = out / "instructions" / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repo / rel, destination)

    metadata = {
        "schema_version": 3,
        "repository_path": str(repo),
        "base_ref": args.base,
        "base_sha": base_sha,
        "merge_base_sha": merge_base,
        "head_ref": args.head,
        "head_sha": head_sha,
        "dirty": False,
        "changed_file_count": len(changed),
        "production_file_count": len(groups["production"]),
        "test_file_count": len(groups["test"]),
        "doc_file_count": len(groups["doc"]),
        "runtime_context_file_count": len(context_files),
        "unchanged_runtime_dependency_count": sum(1 for item in context_files if not item.get("changed")),
        "reverse_caller_count": coverage.get("reverse_callers", 0),
        "dependency_edge_count": len(edges),
        "unresolved_local_import_count": coverage.get("unresolved_local_imports", 0),
        "runtime_graph_complete": coverage.get("complete") is True,
        "instruction_files": instruction_files,
        "specification_snapshot_sha256": specification_sha256_file(specification_snapshot),
        "specification_source_count": len(specification_sources),
    }
    write_json(out / "metadata.json", metadata)

    packet_files = sorted(path.relative_to(out).as_posix() for path in out.rglob("*") if path.is_file() and path.name not in {"manifest.json", "manifest.sha256"})
    entries = [{"path": rel, "sha256": sha256_file(out / rel), "size": (out / rel).stat().st_size} for rel in packet_files]
    manifest = {"schema_version": 3, "files": entries}
    write_json(out / "manifest.json", manifest)
    manifest_sha = sha256_file(out / "manifest.json")
    (out / "manifest.sha256").write_text(f"{manifest_sha}  manifest.json\n", encoding="utf-8")
    print(json.dumps({
        "packet": str(out), "head_sha": head_sha, "base_sha": base_sha,
        "manifest_sha256": manifest_sha, "runtime_graph_complete": coverage.get("complete"),
        "runtime_context_files": len(context_files), "reverse_callers": coverage.get("reverse_callers", 0),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
