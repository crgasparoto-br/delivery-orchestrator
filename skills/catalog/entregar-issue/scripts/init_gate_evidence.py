#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

FAMILIES = [
    ("F01", "controle positivo simples"), ("F02", "entrada negativa ou contraditoria"),
    ("F03", "multiplas entidades homogeneas"), ("F04", "entidades heterogeneas e associacao"),
    ("F05", "cardinalidade zero, um e muitos"), ("F06", "ordem, repeticao e reentrega"),
    ("F07", "continuidade em varias etapas"), ("F08", "reinicio entre etapas"),
    ("F09", "falhas antes e depois das fronteiras"), ("F10", "retry, duplicidade e concorrencia"),
    ("F11", "estado obsoleto, expirado ou outro tenant"), ("F12", "paridade entre entrypoints"),
    ("F13", "dados historicos, schema anterior e fallbacks"), ("F14", "privacidade e autorizacao publica"),
    ("F15", "documentacao e runbook"), ("F16", "interface visual e acessibilidade"),
    ("F17", "transicoes de elegibilidade"), ("F18", "TOCTOU transacional"),
    ("F19", "durabilidade, indisponibilidade e multiplas instancias"),
    ("F20", "indistinguibilidade publica e ordem dos guards"),
    ("F21", "atomicidade da decisao de negocio"),
    ("F22", "invariantes relacionais e dados legados"),
    ("F23", "vigencia, revisao e invalidacao"),
    ("F24", "revisao e transicao visiveis completas"),
    ("F25", "fechamento produtor contrato consumidor"),
    ("F26", "consistencia da fonte canonica entre superficies"),
    ("F27", "ausencia de contratos documentais concorrentes"),
    ("F28", "elegibilidade de execucao e zero outbound"),
    ("F29", "propagacao de timeout cancelamento e deadline"),
    ("F30", "fechamento capacidade operacao adapter"),
    ("F31", "traducao de request fail-closed"),
    ("F32", "compatibilidade legada por variante"),
    ("F33", "veracidade documental executavel"),
    ("F34", "entrada nao confiavel, modos do parser e ordem de validacao"),
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packet", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--issue", required=True, type=int)
    parser.add_argument("--pull-request", required=True, type=int)
    parser.add_argument("--remote-gate", required=True)
    parser.add_argument("--orchestration-state", required=True)
    parser.add_argument("--requirement-closure", required=True)
    args = parser.parse_args()
    packet = Path(args.packet).resolve()
    remote = Path(args.remote_gate).resolve()
    state_path = Path(args.orchestration_state).resolve()
    closure_path = Path(args.requirement_closure).resolve()
    required = [packet / "metadata.json", packet / "manifest.json", packet / "risk_detection.json", remote, state_path, closure_path]
    if any(not path.is_file() or path.stat().st_size == 0 for path in required):
        print("error: packet, remote gate, risk detection, orchestration state, or requirement closure is invalid", file=sys.stderr)
        return 2
    metadata = load(packet / "metadata.json")
    detection = load(packet / "risk_detection.json")
    detected = detection.get("flags") or {}
    state = load(state_path)
    visual_contract = {
        "routes": [], "validator_paths": [], "workflow_paths": [], "documentation_paths": [],
        "controls": [], "controls_rationale": "", "dynamic_surfaces": [], "dynamic_surfaces_rationale": "",
        "table_surfaces": [], "table_surfaces_rationale": "",
        "dialog_surfaces": [], "dialog_surfaces_rationale": "",
    }
    profile = {
        "multi_entity": bool(detected.get("multi_entity", False)),
        "input_parser": bool(detected.get("input_parser", False)),
        "multi_step": bool(detected.get("multi_step", False)),
        "persistence": bool(detected.get("persistence", False)),
        "durable_persistence_required": bool(detected.get("durable_persistence_required", False)),
        "persistence_boundaries": [], "external_dependencies": [],
        "multiple_entrypoints": list(detected.get("multiple_entrypoints") or []),
        "authorization": bool(detected.get("authorization", False)),
        "privacy": bool(detected.get("privacy", False)),
        "visual": bool(detected.get("visual", False)), "visual_contract": visual_contract,
        "data_migration": bool(detected.get("data_migration", False)),
        "fallback_paths": bool(detected.get("fallback_paths", False)),
        "documentation_impact": bool(detected.get("documentation_impact", True)),
        "read_model_closure": bool(detected.get("read_model_closure", False)),
        "canonical_source_consistency": bool(detected.get("canonical_source_consistency", False)),
        "documentation_contract_transition": bool(detected.get("documentation_contract_transition", False)),
        "runtime_policy": bool(detected.get("runtime_policy", False)),
        "adapter_contract": bool(detected.get("adapter_contract", False)),
        "request_translation": bool(detected.get("request_translation", False)),
        "legacy_compatibility": bool(detected.get("legacy_compatibility", False)),
        "documentation_claims": bool(detected.get("documentation_claims", False)),
        "audit_packet_published": False,
        "eligibility_sources": [], "transactional_authorization_operations": [],
        "public_boundaries": [], "transactional_business_operations": [],
        "structural_invariants": [], "freshness_sources": [],
        "stateful_ui_transitions": [],
        "execution_state_boundaries": [], "control_propagation_paths": [],
        "capability_operation_mappings": [], "request_translation_mappings": [],
        "legacy_compatibility_matrix": [], "documentation_claim_inventory": [],
        "input_parser_contract": {
            "accepted_modes": [],
            "structural_invariants": [],
            "mode_invariant_matrix": [],
            "consumed_fields": [],
            "field_scope_placements": [],
            "mode_field_scope_matrix": [],
            "raw_boundary_stages": [],
            "raw_boundary_cases": [],
            "error_precedence_cases": [],
            "control_ids": [],
            "hierarchical": False,
        },
    }
    template = {
        "schema_version": 9,
        "repository": args.repository,
        "repository_path": metadata["repository_path"],
        "issue": args.issue,
        "base_ref": metadata["base_ref"],
        "head_sha": metadata["head_sha"],
        "head_sha_after": "",
        "packet_path": str(packet),
        "packet_manifest_sha256": sha256(packet / "manifest.json"),
        "orchestration_state": {"path": str(state_path), "sha256": sha256(state_path)},
        "risk_detection": {"path": str(packet / "risk_detection.json"), "sha256": sha256(packet / "risk_detection.json")},
        "requirement_closure": {"path": str(closure_path), "sha256": sha256(closure_path)},
        "risk_overrides": [],
        "remote_gate": {"snapshot_path": str(remote), "snapshot_sha256": sha256(remote), "pull_request": args.pull_request},
        "risk_profile": profile,
        "requirements": [], "wrong_implementations": [], "evidence": [], "scenarios": [],
        "scenario_families": [{"id": fid, "name": name, "applicable": None, "rationale": "", "cases": []} for fid, name in FAMILIES],
        "passes": {
            "pass_a": {"status": "pending", "requirement_ids": [], "evidence": []},
            "pass_b": {"status": "pending", "plan_path": "", "plan_sha256": "", "novel_scenarios": [], "evidence": []},
        },
        "findings": [], "later_findings_imported": [], "validation_commands": [],
        "handoff": {
            "independent_audit_required": True, "same_conversation_prohibited": True,
            "new_conversation_instruction": "", "audit_command": "",
            "issue_completion": "complete", "remaining_issue_ids": [],
            "parent_issue_must_remain_open": False,
        },
    }
    if state.get("schema_version") != 3:
        print("error: orchestration state schema_version must be 3", file=sys.stderr)
        return 2
    remote_data = load(remote)
    if remote_data.get("schema_version") != 4:
        print("error: remote gate schema_version must be 4", file=sys.stderr)
        return 2
    if state.get("head_sha") != metadata.get("head_sha"):
        print("error: orchestration state and packet use different SHAs", file=sys.stderr)
        return 2
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
