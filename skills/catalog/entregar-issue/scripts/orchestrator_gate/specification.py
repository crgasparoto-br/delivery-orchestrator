from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

OBLIGATION_RE = re.compile(
    r"\b(deve(?:m|rá|rão)?|não pode(?:m)?|nunca|somente|apenas|"
    r"preserv\w*|mant\w*|exib\w*|diferenci\w*|bloque\w*|permit\w*|garant\w*|"
    r"reutiliz\w*|evit\w*|remov\w*|restaur\w*|funcion\w*|possu\w*|us\w*|"
    r"aplic\w*|valid\w*|proteg\w*|imped\w*|referenci\w*|consum\w*|"
    r"aliment\w*|impact\w*|ger\w*|deriv\w*|equival\w*|catalog\w*|implement\w*)\b",
    re.IGNORECASE,
)
EXHAUSTIVE_RE = re.compile(
    r"\b(tod[oa]s?|cada|demais|suportad[oa]s?|integral(?:mente)?|qualquer|nenhum[oa]?|"
    r"nunca|sempre|diferenciar|distint[oa]s?|separad[oa]s?|equivalent(?:e|es)?)\b",
    re.IGNORECASE,
)
OBSERVABLE_RE = re.compile(
    r"\b(resumid[oa]|clar[oa]|visível|visiveis|amigável|legível|consistente|diferenciar|"
    r"distint[oa]s?|separad[oa]s?|responsiv[oa]|acessível|estável|imediatamente|"
    r"sem rolagem|sem corte|sem revelar)\b",
    re.IGNORECASE,
)
NEGATIVE_RE = re.compile(r"\b(não|nunca|somente|apenas|sem|nenhum[oa]?)\b", re.IGNORECASE)
TEMPORAL_RE = re.compile(r"\b(imediatamente|antes|depois|durante|ap[oó]s|ao recarregar|voltar|avan[cç]ar|futuro|passad[oa]|semana|per[ií]odo|vig[eê]ncia|data alvo)\b", re.IGNORECASE)
REFERENCE_LIVENESS_RE = re.compile(
    r"\b(continua(?:m)?\s+(?:v[aá]lid\w*|acess[ií]vel\w*)|revalid\w*|no momento d[aeo]|"
    r"ap[oó]s aprova[cç][aã]o|antes de liberar|refer[eê]ncias? obrigat[oó]rias?|origem ainda existente)\b",
    re.IGNORECASE,
)
TEMPORAL_DESTINATION_RE = re.compile(
    r"\b(futuro|passad[oa]|semana|per[ií]odo|vig[eê]ncia|data alvo|destino futuro|alvo futuro|"
    r"workoutdate|weekstartdate|dueon|plannedon)\b",
    re.IGNORECASE,
)
ISOLATION_RE = re.compile(r"\b(outro paciente|outro usuário|outro tenant|isolad[oa]|não reutilizar|não misturar)\b", re.IGNORECASE)
FRESHNESS_RE = re.compile(r"\b(vigente|atual|revisad[oa]|aprova(?:do|da)|vers[aã]o|consentimento)\b", re.IGNORECASE)
ATOMICITY_RE = re.compile(
    r"\b(transa[cç][aã]o|concorr[eê]ncia|deduplica[cç][aã]o|duplicidade|"
    r"[uú]nic[oa]|can[oô]nic[oa]|at[oô]mic[oa])\b",
    re.IGNORECASE,
)
AFTERMATH_RE = re.compile(r"\b(ap[oó]s|convertid[oa]|confirma[cç][aã]o|pr[oó]ximas? a[cç][oõ]es|filtro|localiz\w*)\b", re.IGNORECASE)
REVIEW_SURFACE_RE = re.compile(
    r"\b(revis[aã]o|identifica[cç][aã]o|contato|origem|respons[aá]vel|unidade|"
    r"hist[oó]rico|consentimento)\b",
    re.IGNORECASE,
)
SOURCE_CATALOG_RE = re.compile(
    r"\b(equivalent(?:e|es)?|cat[aá]logo|siglas?|m[eé]todos?|planilha|aba|"
    r"par[aâ]metros? t[eé]cnicos?|lista de|tipos previstos|dados da fonte)\b",
    re.IGNORECASE,
)
STRUCTURAL_RE = re.compile(
    r"\b(arquitetur\w*|estrutur\w*|reutiliz\w*|compartilh\w*|single source|"
    r"gram[aá]tica concorrente|parser paralelo|caminho can[oô]nic\w*|parser can[oô]nic\w*|"
    r"executor can[oô]nic\w*)\b",
    re.IGNORECASE,
)
FORBIDDEN_IMPLEMENTATION_RE = re.compile(
    r"\b(n[aã]o|nunca)\s+(?:deve\s+)?(?:criar|manter|duplicar|introduzir|usar)\b.{0,80}"
    r"\b(parser|gram[aá]tica|fonte|caminho|fallback|depend[eê]ncia|regra|vocabul[aá]rio|regex|handler|adapter|executor)\b",
    re.IGNORECASE,
)
CANONICAL_PATH_RE = re.compile(
    r"\b(caminho can[oô]nic\w*|parser can[oô]nic\w*|parser especializ\w*|executor can[oô]nic\w*|"
    r"gram[aá]tica concorrente|parser paralelo)\b",
    re.IGNORECASE,
)
DEPENDENCY_INDEPENDENCE_RE = re.compile(
    r"\b(sem depender|n[aã]o depender|independen\w* de|sem exigir).{0,40}\b(llm|provider|fallback|rede|servi[cç]o|hor[aá]rio)\b",
    re.IGNORECASE,
)
PRECEDENCE_RE = re.compile(
    r"\b(preced[eê]ncia|intercept\w*|antes d[oa] parser|antes d[oa] handler|"
    r"cair novamente no fallback|ordem de (?:parser|handler|fonte))\b",
    re.IGNORECASE,
)
SEMANTIC_EFFECT_RE = re.compile(
    r"\b(referenci\w*|consum\w*|aliment\w*|impact\w*|ger\w*|deriv\w*)\b",
    re.IGNORECASE,
)
SCOPE_REDUCTION_RE = re.compile(
    r"\b(fora do escopo|pr[oó]xima evolu[cç][aã]o|n[aã]o implementa|"
    r"interface pendente|apenas backend|somente backend|funda[cç][aã]o backend|"
    r"seed m[ií]nimo|pend[eê]ncia futura|ser[aá] tratado em outra issue)\b",
    re.IGNORECASE,
)
TEXTUAL_KINDS = {
    "issue-body", "issue-comment", "subissue", "user-decision", "document",
    "attachment-extract", "spreadsheet-extract", "other-text",
}
DECISION_KINDS = {"issue-body", "issue-comment", "subissue", "user-decision"}
DOC_SUFFIXES = {".md", ".mdx", ".txt", ".rst", ".adoc"}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def normalize(line: str) -> str:
    value = line.strip()
    value = re.sub(r"^[-*+]\s+", "", value)
    value = re.sub(r"^\d+[.)]\s+", "", value)
    value = re.sub(r"^- \[[ xX]\]\s+", "", value)
    value = value.strip("| ")
    value = re.sub(r"\s+", " ", value)
    return value


def flags_for(text: str) -> list[str]:
    flags: list[str] = []
    for name, pattern in (
        ("exhaustive", EXHAUSTIVE_RE),
        ("observable", OBSERVABLE_RE),
        ("negative", NEGATIVE_RE),
        ("temporal", TEMPORAL_RE),
        ("reference-liveness", REFERENCE_LIVENESS_RE),
        ("temporal-destination", TEMPORAL_DESTINATION_RE),
        ("isolation", ISOLATION_RE),
        ("freshness", FRESHNESS_RE),
        ("atomicity", ATOMICITY_RE),
        ("aftermath", AFTERMATH_RE),
        ("review-surface", REVIEW_SURFACE_RE),
        ("source-catalog", SOURCE_CATALOG_RE),
        ("structural", STRUCTURAL_RE),
        ("forbidden-implementation", FORBIDDEN_IMPLEMENTATION_RE),
        ("canonical-path", CANONICAL_PATH_RE),
        ("dependency-independence", DEPENDENCY_INDEPENDENCE_RE),
        ("precedence", PRECEDENCE_RE),
        ("semantic-effect", SEMANTIC_EFFECT_RE),
    ):
        if pattern.search(text):
            flags.append(name)
    return flags


def candidate_key(source_id: str, line: int, text: str) -> str:
    return sha256_bytes(f"{source_id}\n{line}\n{text}".encode("utf-8"))


def load_snapshot(snapshot_path: Path, errors: list[str]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    if not snapshot_path.is_file() or snapshot_path.stat().st_size == 0:
        errors.append(f"specification snapshot missing or empty: {snapshot_path}")
        return {}, {}
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"specification snapshot invalid JSON: {exc}")
        return {}, {}
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != 1:
        errors.append("specification snapshot schema_version must be 1")
        return {}, {}
    sources = snapshot.get("sources") or []
    if not isinstance(sources, list) or not sources:
        errors.append("specification snapshot must contain sources")
        return snapshot, {}
    by_id: dict[str, dict[str, Any]] = {}
    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            errors.append(f"specification source {index} is invalid")
            continue
        sid = str(source.get("id") or "").strip()
        if not sid or sid in by_id:
            errors.append(f"specification source id missing or duplicate: {sid}")
            continue
        rel = str(source.get("path") or "")
        path = Path(rel)
        if not path.is_absolute():
            path = (snapshot_path.parent / path).resolve()
        if not path.is_file():
            errors.append(f"specification source file missing: {sid}")
        elif source.get("sha256") != sha256_file(path):
            errors.append(f"specification source hash mismatch: {sid}")
        source = dict(source)
        source["resolved_path"] = str(path)
        by_id[sid] = source
    primary = str(snapshot.get("primary_source_id") or "")
    if primary not in by_id or by_id.get(primary, {}).get("kind") != "issue-body":
        errors.append("specification snapshot primary_source_id must identify the issue body")
    for sid, source in by_id.items():
        if source.get("textual") is False:
            extract_id = str(source.get("extract_source_id") or "")
            if extract_id not in by_id or by_id.get(extract_id, {}).get("textual") is not True:
                errors.append(f"binary specification source {sid} requires a textual extraction source")
    return snapshot, by_id


def extract_candidates(snapshot_path: Path, errors: list[str]) -> tuple[dict[str, Any], dict[str, dict[str, Any]], list[dict[str, Any]]]:
    snapshot, sources = load_snapshot(snapshot_path, errors)
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sid, source in sources.items():
        if source.get("textual") is not True:
            continue
        path = Path(str(source.get("resolved_path") or ""))
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception as exc:
            errors.append(f"cannot read textual specification source {sid}: {exc}")
            continue
        for line_no, raw in enumerate(lines, start=1):
            text = normalize(raw)
            if not text or text.startswith("#") or set(text) <= {"-", ":", " "}:
                continue
            if not (OBLIGATION_RE.search(text) or raw.lstrip().startswith("- [")):
                continue
            key = candidate_key(sid, line_no, text)
            if key in seen:
                continue
            seen.add(key)
            candidates.append({
                "candidate_key": key,
                "source_id": sid,
                "source_sha256": source.get("sha256"),
                "source_line": line_no,
                "source_text": text,
                "flags": flags_for(text),
            })
    return snapshot, sources, candidates


def _doc_path(path: str) -> bool:
    lower = path.lower()
    name = Path(lower).name
    return Path(lower).suffix in DOC_SUFFIXES or name.startswith("readme") or name == "agents.md"


def detect_scope_reduction_matches(repo: Path, base_ref: str, head_sha: str) -> list[dict[str, Any]]:
    proc = subprocess.run(
        ["git", "diff", "--unified=0", f"{base_ref}...{head_sha}", "--"],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "git diff failed")
    current_path = ""
    new_line = 0
    matches: list[dict[str, Any]] = []
    hunk_re = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
    for raw in proc.stdout.splitlines():
        if raw.startswith("+++ b/"):
            current_path = raw[6:]
            continue
        hunk = hunk_re.match(raw)
        if hunk:
            new_line = int(hunk.group(1))
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            text = raw[1:]
            if current_path and _doc_path(current_path) and SCOPE_REDUCTION_RE.search(text):
                matches.append({"path": current_path, "line": new_line, "text": text.strip()})
            new_line += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            continue
        elif raw.startswith(" "):
            new_line += 1
    return matches
