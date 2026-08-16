#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REQUIRED = {
    "issue.md", "production.patch", "production_context_files.json", "dependency_edges.json",
    "unresolved_local_imports.json", "runtime_graph_coverage.json", "risk_detection.json",
    "docs.patch", "tests.patch", "instruction_files.json", "metadata.json", "manifest.json",
    "specification-snapshot.json",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packet", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    packet = Path(args.packet).resolve()
    missing = sorted(name for name in REQUIRED if not (packet / name).is_file())
    if missing or not (packet / "production-context").is_dir():
        print(f"error: invalid audit packet, missing={missing}", file=sys.stderr)
        return 2
    plan = {
        "schema_version": 3,
        "packet_path": str(packet),
        "source_materials": [
            "issue.md", "production.patch", "production_context_files.json", "dependency_edges.json",
            "unresolved_local_imports.json", "runtime_graph_coverage.json", "risk_detection.json",
            "production-context/", "docs.patch", "instruction_files.json", "instructions/",
            "specification-snapshot.json", "specification-sources/",
        ],
        "forbidden_sources_used": [],
        "created_before_tests_inspection": True,
        "hypotheses": [], "scenario_blueprints": [], "reviewed_runtime_context_files": [],
        "unchanged_dependency_risks": [], "reverse_caller_risks": [],
        "persistence_boundary_blueprints": [], "runtime_contract_blueprints": [],
        "input_parser_blueprints": [], "risk_detection_challenges": [],
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
