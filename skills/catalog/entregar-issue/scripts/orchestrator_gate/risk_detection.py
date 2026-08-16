from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

RULES = {
    "input_parser": [
        r"\b(parser|parse(?:d|s|r|ing)?|decoder|decode|deserializ\w*|lexer|tokenizer)\b",
        r"\b(xml|sgml|ofx|csv|yaml|toml|encoding|bom|raw bytes?|conteudo bruto|conteúdo bruto)\b",
    ],
    "runtime_policy": [
        r"\b(resolver|executor|retry|fallback|timeout|abortsignal|deadline|cancel(?:lation|amento)?|max[_ -]?attempts)\b",
        r"\b(ready|degraded|disabled|invalid)\b.*\b(state|status|config)",
    ],
    "adapter_contract": [
        r"\b(capabilit(?:y|ies)|capacidade|support matrix|matriz de suporte|adapter|provider)\b",
        r"\b(operation|opera[cç][aã]o|supportsoperation|supportedoperations)\b",
    ],
    "request_translation": [
        r"\b(tools?|web[_ -]?search|structured output|responsejsonschema|response schema|multimodal|embedding|transcription|image[_ -]?(generation|edit)|mime)\b",
        r"\b(translate|traduz|convert|converter|representable|represent[aá]vel)\b",
    ],
    "legacy_compatibility": [
        r"\b(legacy|legado|compatib|preserv(?:e|ar)|unchanged consumer|consumidor.*n[aã]o migrado|no observable change|sem mudan[cç]a observ[aá]vel)\b",
    ],
    "documentation_claims": [
        r"\b(supports?|suporta|guarantees?|garante|rejects?|rejeita|preserves?|preserva|never|nunca|always|sempre|before any (call|network)|antes de qualquer chamada|end[- ]to[- ]end|ponta a ponta)\b",
    ],
    "persistence": [
        r"\b(prisma|drizzle|sequelize|typeorm|mongoose|repository|database|db\.|sql|redis|storage|persist|transaction)\b",
        r"\b(insert|update|delete|upsert|commit|rollback|migration)\b",
    ],
    "fallback_paths": [
        r"\b(fallback|degrad|in[- ]?memory|memory store|cache|retry|circuit breaker|catch)\b",
        r"\b(provider|adapter).*(unavailable|failure|error)\b",
    ],
    "authorization": [r"\b(auth\w*|authoriz\w*|permission\w*|role\w*|entitlement\w*|access control|acl|rbac)\b"],
    "privacy": [r"\b(tenant|pii|personal data|sensitive|privacy|non[- ]?enumeration|isolation)\b"],
    "multi_step": [r"\b(webhook|callback|queue|job|pending|continuation|conversation|state machine|event handler)\b"],
    "data_migration": [r"\b(migration|backfill|legacy|historical|schema version|compatibility)\b"],
    "read_model_closure": [
        r"\b(history|historical|timeline|version|versioning|pagination|authorship|origin|supersession|vigency|previous records)\b",
        r"\b(hist[oó]ric|linha do tempo|vers[aã]o|vers[oõ]es|pagina[cç][aã]o|autoria|origem|supersess[aã]o|vig[eê]ncia|registros anteriores)\b",
    ],
    "canonical_source_consistency": [
        r"\b(canonical|source of truth|same semantic field|consistent across|coherent with)\b",
        r"\b(can[oô]nic|fonte de verdade|mesmo campo sem[aâ]ntico|consistente entre|coerente com)\b",
    ],
    "documentation_contract_transition": [
        r"\b(route|redirect|legacy|deprecated|retire|replace|rename|workspace)\b",
        r"\b(rota|redirecion|legado|obsoleto|aposent|substitu|renome|workspace)\b",
    ],
}

VISUAL_EXTENSIONS = {".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".html"}
PERSISTENCE_PATH_MARKERS = {"migration", "schema", "repository", "repositories", "models", "entities", "database", "prisma"}
ENTRYPOINT_MARKERS = {"api", "endpoint", "route", "router", "controller", "handler", "webhook", "resolver", "procedure", "job", "cli", "command", "simulator"}
DOC_EXTENSIONS = {".md", ".mdx", ".rst", ".adoc"}
INPUT_PARSER_OPERATION = re.compile(
    r"\b(?:parse|parser|decode|decoder|deserializ|lexer|lex|tokeniz)\w*",
    re.IGNORECASE,
)
INPUT_PARSER_FORMAT = re.compile(
    r"(?:xml|sgml|ofx|csv|yaml|toml|encoding|bom|raw bytes?|conteudo bruto|conteúdo bruto)",
    re.IGNORECASE,
)
INPUT_PARSER_PATH = re.compile(r"(^|/)[^/]*(parser|decoder|deserializ|lexer|tokenizer)[^/]*\.[^/]+$", re.IGNORECASE)


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def detect(repo: Path, changed_files: Iterable[str], supplemental_text: str = "") -> dict:
    signals: dict[str, list[dict]] = {key: [] for key in [*RULES, "visual", "multiple_entrypoints", "documentation_impact"]}
    entrypoints: list[str] = []
    for rel in sorted(set(changed_files)):
        path = repo / rel
        suffix = path.suffix.lower()
        lower_path = rel.lower()
        text = _read(path)
        sample = text[:250000]
        path_parts = set(Path(lower_path).parts)

        if INPUT_PARSER_PATH.search(lower_path):
            signals["input_parser"].append({"path": rel, "reason": "parser/decoder/tokenizer path changed", "confidence": "high"})
        elif suffix not in DOC_EXTENSIONS and INPUT_PARSER_OPERATION.search(sample) and INPUT_PARSER_FORMAT.search(sample):
            signals["input_parser"].append({"path": rel, "reason": "code combines parser operation with structured/raw input format", "confidence": "high"})
        if suffix in VISUAL_EXTENSIONS or any(token in lower_path for token in ("/components/", "/pages/", "/views/", "/app/")):
            signals["visual"].append({"path": rel, "reason": "frontend or style file changed", "confidence": "high"})
        if path_parts & PERSISTENCE_PATH_MARKERS or suffix in {".sql", ".prisma"}:
            signals["persistence"].append({"path": rel, "reason": "persistence/schema path changed", "confidence": "high"})
        if "migration" in lower_path or suffix == ".sql":
            signals["data_migration"].append({"path": rel, "reason": "migration or SQL file changed", "confidence": "high"})
        if suffix in DOC_EXTENSIONS or Path(rel).name.lower() in {"readme", "agents.md", "contributing.md"}:
            signals["documentation_impact"].append({"path": rel, "reason": "documentation file changed", "confidence": "high"})
        for marker in ENTRYPOINT_MARKERS:
            if marker in lower_path:
                entrypoints.append(rel)
                break
        for field, patterns in RULES.items():
            for pattern in patterns:
                match = re.search(pattern, sample, flags=re.IGNORECASE | re.MULTILINE)
                if match:
                    signals[field].append({
                        "path": rel,
                        "reason": f"matched {pattern}",
                        "match": match.group(0)[:120],
                        "confidence": "high" if field in {"authorization", "privacy", "persistence", "runtime_policy", "adapter_contract", "request_translation"} else "medium",
                    })
                    break
    if supplemental_text:
        supplemental_sample = supplemental_text[:1000000]
        if INPUT_PARSER_OPERATION.search(supplemental_sample) and INPUT_PARSER_FORMAT.search(supplemental_sample):
            signals["input_parser"].append({"path": "<git-diff>", "reason": "diff combines parser operation with structured/raw input format", "confidence": "high"})
        for field, patterns in RULES.items():
            for pattern in patterns:
                match = re.search(pattern, supplemental_text[:1000000], flags=re.IGNORECASE | re.MULTILINE)
                if match:
                    signals[field].append({
                        "path": "<git-diff>",
                        "reason": f"diff matched {pattern}",
                        "match": match.group(0)[:120],
                        "confidence": "high" if field in {"authorization", "privacy", "persistence", "runtime_policy", "adapter_contract", "request_translation"} else "medium",
                    })
                    break
    entrypoints = sorted(set(entrypoints))
    if len(entrypoints) > 1:
        signals["multiple_entrypoints"] = [
            {"path": item, "reason": "multiple public or asynchronous entrypoints changed", "confidence": "high"}
            for item in entrypoints
        ]
    flags = {
        "multi_entity": False,
        "input_parser": bool([item for item in signals["input_parser"] if item.get("confidence") == "high"]),
        "multi_step": bool(signals["multi_step"]),
        "persistence": bool(signals["persistence"]),
        "durable_persistence_required": bool(signals["persistence"] and signals["multi_step"]),
        "authorization": bool(signals["authorization"]),
        "privacy": bool(signals["privacy"]),
        "visual": bool(signals["visual"]),
        "data_migration": bool(signals["data_migration"]),
        "fallback_paths": bool(signals["fallback_paths"]),
        "documentation_impact": bool(signals["documentation_impact"]),
        "read_model_closure": bool(signals["read_model_closure"]),
        "canonical_source_consistency": bool(signals["canonical_source_consistency"]),
        "documentation_contract_transition": bool(signals["documentation_contract_transition"]),
        "runtime_policy": bool(signals["runtime_policy"]),
        "adapter_contract": bool(signals["adapter_contract"]),
        "request_translation": bool(signals["request_translation"]),
        "legacy_compatibility": bool(signals["legacy_compatibility"]),
        "documentation_claims": bool(signals["documentation_claims"]),
        "multiple_entrypoints": entrypoints,
    }
    high_confidence = {
        key: bool([item for item in value if item.get("confidence") == "high"])
        for key, value in signals.items()
    }
    return {
        "schema_version": 1,
        "flags": flags,
        "signals": signals,
        "high_confidence": high_confidence,
        "changed_files": sorted(set(changed_files)),
    }
