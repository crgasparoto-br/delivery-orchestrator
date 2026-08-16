from __future__ import annotations

import ast
import json
import os
import re
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

SUPPORTED_SOURCE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".java", ".kt", ".kts", ".cs", ".fs", ".vb",
}
SNAPSHOT_EXTENSIONS = SUPPORTED_SOURCE_EXTENSIONS | {
    ".json", ".sql", ".graphql", ".gql", ".yaml", ".yml", ".xml", ".toml",
}
MAX_FILES = 8000
IGNORED_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", ".next", "coverage", "target", "bin", "obj", "__pycache__"}


def _read_text(repo: Path, rel: str, virtual: dict[str, str]) -> str | None:
    if rel in virtual:
        return virtual[rel]
    path = repo / rel
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw:
        return None
    return raw.decode("utf-8", errors="replace")


def _all_files(repo: Path, extensions: set[str], virtual: dict[str, str]) -> list[str]:
    result: set[str] = {
        rel for rel in virtual if PurePosixPath(rel).suffix.lower() in extensions
    }
    for root, dirs, files in os.walk(repo):
        dirs[:] = [name for name in dirs if name not in IGNORED_DIRS]
        base = Path(root)
        for name in files:
            path = base / name
            if path.suffix.lower() in extensions:
                result.add(path.relative_to(repo).as_posix())
    return sorted(result)


def _strip_jsonc(text: str) -> str:
    output: list[str] = []
    index = 0
    in_string = False
    quote = ""
    escaped = False
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                in_string = False
            index += 1
            continue
        if char in {"\"", "'"}:
            in_string = True
            quote = char
            output.append(char)
            index += 1
            continue
        if char == "/" and nxt == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
            continue
        if char == "/" and nxt == "*":
            index += 2
            while index + 1 < len(text) and not (text[index] == "*" and text[index + 1] == "/"):
                index += 1
            index += 2
            continue
        output.append(char)
        index += 1
    return re.sub(r",\s*([}\]])", r"\1", "".join(output))


def _load_jsonc(path: Path) -> tuple[dict[str, Any], str | None]:
    try:
        value = json.loads(_strip_jsonc(path.read_text(encoding="utf-8")))
    except Exception as exc:
        return {}, str(exc)
    if not isinstance(value, dict):
        return {}, "top-level value is not an object"
    return value, None


def _load_json(path: Path) -> dict[str, Any]:
    value, _ = _load_jsonc(path)
    return value


def _candidate_files(repo: Path, base: str, extensions: Iterable[str], virtual: set[str]) -> list[str]:
    base = str(PurePosixPath(base))
    candidates = [base]
    if not PurePosixPath(base).suffix:
        candidates.extend(base + ext for ext in extensions)
        candidates.extend(str(PurePosixPath(base) / ("index" + ext)) for ext in extensions)
    return [candidate for candidate in candidates if (repo / candidate).is_file() or candidate in virtual]


# ---------- JavaScript / TypeScript ----------

JS_IMPORT_RE = re.compile(
    r"(?:import|export)\s+(?:[^\"']*?\s+from\s+)?[\"']([^\"']+)[\"']"
    r"|require\(\s*[\"']([^\"']+)[\"']\s*\)"
    r"|import\(\s*[\"']([^\"']+)[\"']\s*\)"
)


def _js_imports(text: str) -> list[str]:
    return [next(group for group in match.groups() if group is not None) for match in JS_IMPORT_RE.finditer(text)]


def _config_candidate(base: Path, value: str) -> Path | None:
    raw = value.strip()
    candidates: list[Path] = []
    if raw.startswith(".") or raw.startswith("/"):
        candidate = (base / raw).resolve() if not raw.startswith("/") else Path(raw)
        candidates.extend([candidate, candidate.with_suffix(".json") if not candidate.suffix else candidate])
    else:
        package = raw.split("/", 1)[0] if not raw.startswith("@") else "/".join(raw.split("/")[:2])
        rest = raw[len(package):].lstrip("/")
        package_dir = base / "node_modules" / package
        candidates.extend([
            package_dir / (rest or "tsconfig.json"),
            package_dir / (rest + ".json") if rest else package_dir / "tsconfig.json",
        ])
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _compiler_configs(path: Path, seen: set[Path], errors: list[str]) -> list[tuple[dict[str, Any], Path]]:
    path = path.resolve()
    if path in seen:
        errors.append(f"cyclic TypeScript config extends: {path}")
        return []
    seen.add(path)
    data, error = _load_jsonc(path)
    if error:
        errors.append(f"cannot parse TypeScript config {path}: {error}")
        return []
    result: list[tuple[dict[str, Any], Path]] = []
    extends = data.get("extends")
    if isinstance(extends, str):
        parent = _config_candidate(path.parent, extends)
        if parent is None:
            errors.append(f"cannot resolve TypeScript config extends {extends!r} from {path}")
        else:
            result.extend(_compiler_configs(parent, seen, errors))
    compiler = data.get("compilerOptions") or {}
    if isinstance(compiler, dict):
        result.append((compiler, path.parent))
    return result


def _script_aliases(repo: Path) -> tuple[list[tuple[str, list[str], Path]], list[str]]:
    aliases: list[tuple[str, list[str], Path]] = []
    errors: list[str] = []
    config_names = {
        "vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs",
        "webpack.config.ts", "webpack.config.js", "webpack.config.mjs", "webpack.config.cjs",
        "babel.config.js", "babel.config.cjs", "babel.config.mjs",
    }
    pair_re = re.compile(
        r"[\"'](?P<key>@[^\"']*|~[^\"']*|#[^\"']*|src|app)[\"']\s*:\s*"
        r"(?:(?:path\.)?resolve\(\s*__dirname\s*,\s*[\"'](?P<resolved>[^\"']+)[\"']\s*\)|"
        r"[\"'](?P<plain>[^\"']+)[\"'])"
    )
    array_re = re.compile(
        r"find\s*:\s*[\"'](?P<key>[^\"']+)[\"'][^}]*?replacement\s*:\s*"
        r"(?:(?:path\.)?resolve\(\s*__dirname\s*,\s*[\"'](?P<resolved>[^\"']+)[\"']\s*\)|"
        r"[\"'](?P<plain>[^\"']+)[\"'])",
        re.S,
    )
    for config_path in repo.rglob("*"):
        if config_path.name not in config_names or any(part in IGNORED_DIRS for part in config_path.parts):
            continue
        try:
            config_text = config_path.read_text(encoding="utf-8", errors="strict")
        except Exception as exc:
            errors.append(f"cannot read JavaScript alias config {config_path}: {exc}")
            continue
        matched = 0
        for pattern in (pair_re, array_re):
            for match in pattern.finditer(config_text):
                key = match.group("key")
                target = match.group("resolved") or match.group("plain")
                aliases.append((key, [target.lstrip("/")], config_path.parent))
                matched += 1
        if re.search(r"\balias\s*:", config_text) and matched == 0:
            errors.append(
                f"cannot statically resolve aliases declared in {config_path}; use tsconfig paths or literal alias entries"
            )
    return aliases, errors


def _json_aliases(repo: Path) -> tuple[list[tuple[str, list[str], Path]], list[str]]:
    aliases: list[tuple[str, list[str], Path]] = []
    errors: list[str] = []
    for package_path in repo.rglob("package.json"):
        if any(part in IGNORED_DIRS for part in package_path.parts):
            continue
        data, error = _load_jsonc(package_path)
        if error:
            errors.append(f"cannot parse package manifest {package_path}: {error}")
            continue
        for field in ("_moduleAliases", "imports"):
            values = data.get(field)
            if values is None:
                continue
            if not isinstance(values, dict):
                errors.append(f"package manifest {package_path} field {field} must be an object")
                continue
            for key, target in values.items():
                if isinstance(key, str) and isinstance(target, str):
                    aliases.append((key, [target.lstrip("./")], package_path.parent))
                elif isinstance(key, str) and isinstance(target, dict):
                    literal_targets = [
                        str(target[name]).lstrip("./")
                        for name in ("types", "import", "default", "require")
                        if isinstance(target.get(name), str)
                    ]
                    if literal_targets:
                        aliases.append((key, literal_targets, package_path.parent))
                    else:
                        errors.append(
                            f"package manifest {package_path} import alias {key!r} has no supported literal target"
                        )
                else:
                    errors.append(f"package manifest {package_path} contains a non-literal alias in {field}")
    for name in (".babelrc", ".babelrc.json", "babel.config.json"):
        for config_path in repo.rglob(name):
            if any(part in IGNORED_DIRS for part in config_path.parts):
                continue
            data, error = _load_jsonc(config_path)
            if error:
                errors.append(f"cannot parse Babel alias config {config_path}: {error}")
                continue
            plugins = data.get("plugins") or []
            for plugin in plugins if isinstance(plugins, list) else []:
                if not isinstance(plugin, list) or len(plugin) < 2 or "module-resolver" not in str(plugin[0]):
                    continue
                options = plugin[1] if isinstance(plugin[1], dict) else {}
                values = options.get("alias")
                if values is None:
                    continue
                if not isinstance(values, dict):
                    errors.append(f"Babel module-resolver aliases must be an object in {config_path}")
                    continue
                for key, target in values.items():
                    if isinstance(key, str) and isinstance(target, str):
                        aliases.append((key, [target.lstrip("./")], config_path.parent))
                    else:
                        errors.append(f"Babel alias {key!r} in {config_path} must have a literal string target")
    return aliases, errors


def _ts_configs(repo: Path) -> tuple[list[tuple[str, list[str], Path]], list[Path], list[str]]:
    aliases: list[tuple[str, list[str], Path]] = []
    base_urls: list[Path] = []
    errors: list[str] = []
    config_paths = {
        config_path
        for pattern in ("tsconfig*.json", "jsconfig*.json")
        for config_path in repo.rglob(pattern)
        if not any(part in IGNORED_DIRS for part in config_path.parts)
    }
    for config_path in sorted(config_paths):
        for compiler, config_dir in _compiler_configs(config_path, set(), errors):
            base = (config_dir / str(compiler.get("baseUrl", "."))).resolve()
            if base == repo or repo in base.parents:
                base_urls.append(base)
            paths = compiler.get("paths") or {}
            if not isinstance(paths, dict):
                errors.append(f"compilerOptions.paths must be an object in {config_path}")
                continue
            for pattern, targets in paths.items():
                if isinstance(targets, str):
                    targets = [targets]
                if isinstance(pattern, str) and isinstance(targets, list) and all(
                    isinstance(item, str) for item in targets
                ):
                    aliases.append((pattern, [str(item) for item in targets], base))
                else:
                    errors.append(f"invalid TypeScript path alias {pattern!r} in {config_path}")
    script_aliases, script_errors = _script_aliases(repo)
    json_aliases, json_errors = _json_aliases(repo)
    aliases.extend(script_aliases)
    aliases.extend(json_aliases)
    errors.extend(script_errors)
    errors.extend(json_errors)
    unique: dict[tuple[str, tuple[str, ...], str], tuple[str, list[str], Path]] = {}
    for pattern, targets, base in aliases:
        unique[(pattern, tuple(targets), str(base))] = (pattern, targets, base)
    return list(unique.values()), sorted(set(base_urls)), sorted(set(errors))


def _workspace_packages(repo: Path) -> tuple[dict[str, Path], list[str]]:
    result: dict[str, Path] = {}
    errors: list[str] = []
    for package_path in repo.rglob("package.json"):
        if any(part in IGNORED_DIRS for part in package_path.parts):
            continue
        data, error = _load_jsonc(package_path)
        if error:
            errors.append(f"cannot parse workspace package manifest {package_path}: {error}")
            continue
        name = data.get("name")
        if isinstance(name, str) and name.strip():
            if name in result and result[name] != package_path.parent:
                errors.append(f"duplicate workspace package name {name!r}: {result[name]} and {package_path.parent}")
            result[name] = package_path.parent
    return result, errors


def _alias_match(specifier: str, pattern: str) -> str | None:
    if "*" not in pattern:
        if specifier == pattern:
            return ""
        if specifier.startswith(pattern.rstrip("/") + "/"):
            return specifier[len(pattern.rstrip("/")) + 1:]
        return None
    prefix, suffix = pattern.split("*", 1)
    if not specifier.startswith(prefix) or not specifier.endswith(suffix):
        return None
    return specifier[len(prefix): len(specifier) - len(suffix) if suffix else None]


def _resolve_js(
    repo: Path,
    importer: str,
    specifier: str,
    aliases: list[tuple[str, list[str], Path]],
    base_urls: list[Path],
    workspaces: dict[str, Path],
    virtual: set[str],
) -> tuple[list[str], str, bool]:
    exts = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json")
    if specifier.startswith("."):
        base = (PurePosixPath(importer).parent / specifier).as_posix()
        candidates = _candidate_files(repo, base, exts, virtual)
        return candidates[:1], "relative", True
    alias_matched = False
    for pattern, targets, base_dir in aliases:
        middle = _alias_match(specifier, pattern)
        if middle is None:
            continue
        alias_matched = True
        for target in targets:
            expanded = target.replace("*", middle) if "*" in target else (
                str(PurePosixPath(target) / middle) if middle else target
            )
            try:
                rel = (base_dir / expanded).resolve().relative_to(repo).as_posix()
            except ValueError:
                continue
            candidates = _candidate_files(repo, rel, exts, virtual)
            if candidates:
                return candidates[:1], "tsconfig-path", True
    for base_dir in base_urls:
        try:
            rel = (base_dir / specifier).resolve().relative_to(repo).as_posix()
        except ValueError:
            continue
        candidates = _candidate_files(repo, rel, exts, virtual)
        if candidates:
            return candidates[:1], "tsconfig-base-url", True
    package_name = specifier
    subpath = ""
    if specifier.startswith("@"):
        parts = specifier.split("/")
        if len(parts) >= 2:
            package_name = "/".join(parts[:2])
            subpath = "/".join(parts[2:])
    elif "/" in specifier:
        package_name, subpath = specifier.split("/", 1)
    package_dir = workspaces.get(package_name)
    if package_dir:
        pkg = _load_json(package_dir / "package.json")
        targets: list[str] = [subpath] if subpath else []
        exports = pkg.get("exports")
        if isinstance(exports, str):
            targets.append(exports)
        elif isinstance(exports, dict):
            value = exports.get("." if not subpath else "./" + subpath)
            if isinstance(value, str):
                targets.append(value)
            elif isinstance(value, dict):
                targets.extend(str(value[key]) for key in ("types", "import", "default", "require") if isinstance(value.get(key), str))
        targets.extend(str(pkg[key]) for key in ("types", "module", "main") if isinstance(pkg.get(key), str))
        targets.extend(["src/index", "index"])
        for target in targets:
            try:
                rel = (package_dir / target).resolve().relative_to(repo).as_posix()
            except ValueError:
                continue
            candidates = _candidate_files(repo, rel, exts, virtual)
            if candidates:
                return candidates[:1], "workspace-package", True
        return [], "workspace-package-unresolved", True
    likely_local = (
        specifier.startswith(("@/", "~/", "#"))
        or (specifier.startswith(("src/", "app/")) and (repo / specifier.split("/", 1)[0]).is_dir())
    )
    if likely_local:
        return [], "likely-local-alias-unresolved", True
    return [], "ts-alias-unresolved" if alias_matched else "external", alias_matched


# ---------- Python ----------


def _python_source_roots(repo: Path) -> list[Path]:
    roots = {repo}
    if (repo / "src").is_dir():
        roots.add((repo / "src").resolve())
    for marker in ("pyproject.toml", "setup.py", "setup.cfg"):
        for path in repo.rglob(marker):
            if any(part in IGNORED_DIRS for part in path.parts):
                continue
            roots.add(path.parent.resolve())
            if (path.parent / "src").is_dir():
                roots.add((path.parent / "src").resolve())
    return sorted(roots, key=lambda value: len(value.parts), reverse=True)


def _python_module_index(repo: Path, virtual: dict[str, str]) -> tuple[dict[str, str], set[str]]:
    index: dict[str, str] = {}
    roots = _python_source_roots(repo)
    for rel in _all_files(repo, {".py"}, virtual):
        absolute = (repo / rel).resolve()
        for root in roots:
            try:
                relative = absolute.relative_to(root)
            except ValueError:
                continue
            parts = list(relative.parts)
            if not parts:
                continue
            if parts[-1] == "__init__.py":
                module_parts = parts[:-1]
            else:
                module_parts = parts[:-1] + [PurePosixPath(parts[-1]).stem]
            if module_parts:
                index.setdefault(".".join(module_parts), rel)
    top_level = {module.split(".", 1)[0] for module in index}
    return index, top_level


def _python_imports(
    text: str, importer: str, index: dict[str, str], top_level: set[str]
) -> tuple[list[tuple[str, bool]], str | None]:
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        location = f"line {exc.lineno}" if exc.lineno else "unknown line"
        return [], f"Python source parse error in {importer} at {location}: {exc.msg}"
    result: list[tuple[str, bool]] = []
    importer_module = next((module for module, rel in index.items() if rel == importer), "")
    package_parts = importer_module.split(".")[:-1]
    if PurePosixPath(importer).name == "__init__.py":
        package_parts = importer_module.split(".")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                result.append((alias.name, alias.name.split(".", 1)[0] in top_level))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                trim = max(node.level - 1, 0)
                base_parts = package_parts[:-trim] if trim else package_parts[:]
                if node.module:
                    base_parts.extend(node.module.split("."))
                module = ".".join(base_parts)
                result.append((module, True))
            else:
                module = node.module or ""
                if module:
                    result.append((module, module.split(".", 1)[0] in top_level))
            for alias in node.names:
                candidate = ".".join(part for part in (module, alias.name) if part)
                if candidate in index:
                    result.append((candidate, True))
    # Preserve order without duplicates.
    seen: set[tuple[str, bool]] = set()
    unique: list[tuple[str, bool]] = []
    for item in result:
        if item[0] and item not in seen:
            seen.add(item)
            unique.append(item)
    return unique, None


# ---------- Go ----------


def _go_module(repo: Path) -> str:
    path = repo / "go.mod"
    if not path.is_file():
        return ""
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("module "):
            return line.split(None, 1)[1].strip()
    return ""


def _go_imports(text: str) -> list[str]:
    imports = re.findall(r'(?m)^\s*import\s+"([^"]+)"', text)
    block = re.search(r'(?ms)^\s*import\s*\((.*?)\)', text)
    if block:
        imports.extend(re.findall(r'"([^"]+)"', block.group(1)))
    return imports


def _go_package_files(repo: Path, directory: Path, virtual: dict[str, str]) -> list[str]:
    try:
        rel_dir = directory.resolve().relative_to(repo).as_posix()
    except ValueError:
        return []
    prefix = "" if rel_dir == "." else rel_dir.rstrip("/") + "/"
    files = {
        path.relative_to(repo).as_posix()
        for path in directory.glob("*.go")
        if not path.name.endswith("_test.go")
    }
    files.update(
        rel for rel in virtual
        if rel.startswith(prefix) and "/" not in rel[len(prefix):] and rel.endswith(".go") and not rel.endswith("_test.go")
    )
    return sorted(files)


# ---------- JVM ----------

PACKAGE_RE = re.compile(r"(?m)^\s*package\s+([\w.]+)\s*;?")
JAVA_IMPORT_RE = re.compile(r"(?m)^\s*import\s+(?:static\s+)?([\w.*]+)\s*;?")


def _jvm_index(repo: Path, virtual: dict[str, str]) -> tuple[dict[str, str], dict[str, list[str]], set[str]]:
    classes: dict[str, str] = {}
    packages: dict[str, list[str]] = defaultdict(list)
    files = _all_files(repo, {".java", ".kt", ".kts"}, virtual)
    for rel in files:
        text = _read_text(repo, rel, virtual) or ""
        match = PACKAGE_RE.search(text)
        package = match.group(1) if match else ""
        name = PurePosixPath(rel).stem
        fqcn = ".".join(part for part in (package, name) if part)
        if fqcn:
            classes[fqcn] = rel
        packages[package].append(rel)
    roots = {package.split(".", 1)[0] for package in packages if package}
    return classes, packages, roots


# ---------- .NET ----------

NAMESPACE_RE = re.compile(r"(?m)^\s*namespace\s+([\w.]+)")
USING_RE = re.compile(r"(?m)^\s*using\s+([\w.]+)\s*;")


def _dotnet_index(repo: Path, virtual: dict[str, str]) -> tuple[dict[str, list[str]], set[str]]:
    namespaces: dict[str, list[str]] = defaultdict(list)
    for rel in _all_files(repo, {".cs", ".fs", ".vb"}, virtual):
        text = _read_text(repo, rel, virtual) or ""
        for match in NAMESPACE_RE.finditer(text):
            namespaces[match.group(1)].append(rel)
    roots = {namespace.split(".", 1)[0] for namespace in namespaces}
    return namespaces, roots


def _nearest_project(repo: Path, rel: str) -> Path | None:
    current = (repo / rel).parent
    while current == repo or repo in current.parents:
        projects = sorted([*current.glob("*.csproj"), *current.glob("*.fsproj"), *current.glob("*.vbproj")])
        if projects:
            return projects[0]
        if current == repo:
            break
        current = current.parent
    return None


def _dotnet_project_files(
    repo: Path,
    project: Path,
    virtual: dict[str, str],
    seen: set[Path] | None = None,
) -> tuple[list[str], list[str]]:
    root = project.parent
    files: set[str] = set()
    errors: list[str] = []
    seen = seen if seen is not None else set()
    project = project.resolve()
    if project in seen:
        return [], [f"cyclic .NET ProjectReference detected at {project}"]
    seen.add(project)
    for ext in ("*.cs", "*.fs", "*.vb"):
        for source_path in root.rglob(ext):
            if any(part in IGNORED_DIRS for part in source_path.parts):
                continue
            files.add(source_path.relative_to(repo).as_posix())
    prefix = root.relative_to(repo).as_posix().rstrip("/") + "/"
    files.update(
        rel
        for rel in virtual
        if rel.startswith(prefix) and PurePosixPath(rel).suffix.lower() in {".cs", ".fs", ".vb"}
    )
    try:
        tree = ET.parse(project)
    except Exception as exc:
        errors.append(f"cannot parse .NET project {project}: {exc}")
        return sorted(files), errors
    for node in tree.iter():
        if not node.tag.endswith("ProjectReference") or not node.attrib.get("Include"):
            continue
        referenced = (root / node.attrib["Include"]).resolve()
        if not referenced.is_file() or not (referenced == repo or repo in referenced.parents):
            errors.append(f"cannot resolve .NET ProjectReference {node.attrib['Include']!r} from {project}")
            continue
        referenced_files, referenced_errors = _dotnet_project_files(repo, referenced, virtual, seen)
        files.update(referenced_files)
        errors.extend(referenced_errors)
    return sorted(files), errors


def _kind(ext: str) -> str:
    if ext in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
        return "javascript-typescript"
    if ext == ".py":
        return "python"
    if ext == ".go":
        return "go"
    if ext in {".java", ".kt", ".kts"}:
        return "jvm"
    if ext in {".cs", ".fs", ".vb"}:
        return "dotnet"
    return "data-or-config"


def build_runtime_context(
    repo: Path,
    changed_production: list[str],
    virtual_contents: dict[str, str] | None = None,
) -> tuple[list[dict], list[dict], list[dict], dict]:
    virtual = virtual_contents or {}
    virtual_files = set(virtual)
    aliases, base_urls, js_config_errors = _ts_configs(repo)
    workspaces, workspace_errors = _workspace_packages(repo)
    js_config_errors = sorted(set([*js_config_errors, *workspace_errors]))
    py_index, py_roots = _python_module_index(repo, virtual)
    go_module = _go_module(repo)
    jvm_classes, jvm_packages, jvm_roots = _jvm_index(repo, virtual)
    dotnet_namespaces, dotnet_roots = _dotnet_index(repo, virtual)
    all_sources = _all_files(repo, SUPPORTED_SOURCE_EXTENSIONS, virtual)

    resolved_by_file: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    unresolved_by_file: dict[str, list[dict[str, str]]] = defaultdict(list)
    strategies: set[str] = set()

    for rel in all_sources:
        text = _read_text(repo, rel, virtual)
        if text is None:
            continue
        ext = PurePosixPath(rel).suffix.lower()
        if ext in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
            for spec in _js_imports(text):
                targets, strategy, local = _resolve_js(repo, rel, spec, aliases, base_urls, workspaces, virtual_files)
                strategies.add(strategy)
                if targets:
                    resolved_by_file[rel].extend((spec, target, strategy) for target in targets)
                elif local:
                    unresolved_by_file[rel].append({"importer": rel, "specifier": spec, "reason": "local-import-unresolved", "strategy": strategy})
        elif ext == ".py":
            python_imports, python_error = _python_imports(text, rel, py_index, py_roots)
            if python_error:
                unresolved_by_file[rel].append({
                    "importer": rel,
                    "specifier": "<python-source>",
                    "reason": "source-parse-error",
                    "strategy": "python-ast",
                    "detail": python_error,
                })
                strategies.add("python-ast")
            for spec, local in python_imports:
                target = py_index.get(spec)
                strategy = "python-module" if target else ("python-local-unresolved" if local else "external")
                strategies.add(strategy)
                if target:
                    resolved_by_file[rel].append((spec, target, strategy))
                elif local:
                    unresolved_by_file[rel].append({"importer": rel, "specifier": spec, "reason": "local-import-unresolved", "strategy": strategy})
        elif ext == ".go":
            # Every non-test source file in the same package participates in compilation.
            for target in _go_package_files(repo, (repo / rel).parent, virtual):
                if target != rel:
                    resolved_by_file[rel].append(("<same-go-package>", target, "go-same-package"))
                    strategies.add("go-same-package")
            for spec in _go_imports(text):
                if go_module and (spec == go_module or spec.startswith(go_module + "/")):
                    rel_dir = spec[len(go_module):].lstrip("/")
                    targets = _go_package_files(repo, repo / rel_dir, virtual)
                    strategies.add("go-module")
                    if targets:
                        resolved_by_file[rel].extend((spec, target, "go-module") for target in targets)
                    else:
                        unresolved_by_file[rel].append({"importer": rel, "specifier": spec, "reason": "local-import-unresolved", "strategy": "go-module"})
                else:
                    strategies.add("external")
        elif ext in {".java", ".kt", ".kts"}:
            package_match = PACKAGE_RE.search(text)
            package = package_match.group(1) if package_match else ""
            for target in jvm_packages.get(package, []):
                if target != rel:
                    resolved_by_file[rel].append(("<same-jvm-package>", target, "jvm-same-package"))
                    strategies.add("jvm-same-package")
            for spec in JAVA_IMPORT_RE.findall(text):
                targets = jvm_packages.get(spec[:-2], []) if spec.endswith(".*") else ([jvm_classes[spec]] if spec in jvm_classes else [])
                local = spec.split(".", 1)[0] in jvm_roots
                strategy = "jvm-package" if spec.endswith(".*") else "jvm-class"
                strategies.add(strategy if targets or local else "external")
                if targets:
                    resolved_by_file[rel].extend((spec, target, strategy) for target in targets)
                elif local:
                    unresolved_by_file[rel].append({"importer": rel, "specifier": spec, "reason": "local-import-unresolved", "strategy": strategy})
        elif ext in {".cs", ".fs", ".vb"}:
            project = _nearest_project(repo, rel)
            if project:
                project_files, project_errors = _dotnet_project_files(repo, project, virtual)
                for project_error in project_errors:
                    unresolved_by_file[rel].append({
                        "importer": rel,
                        "specifier": project.relative_to(repo).as_posix(),
                        "reason": "project-configuration-error",
                        "strategy": "dotnet-project",
                        "detail": project_error,
                    })
                for target in project_files:
                    if target != rel:
                        resolved_by_file[rel].append(("<dotnet-project>", target, "dotnet-project"))
                        strategies.add("dotnet-project")
            for spec in USING_RE.findall(text):
                targets = [target for namespace, files in dotnet_namespaces.items() if namespace == spec or namespace.startswith(spec + ".") for target in files]
                local = spec.split(".", 1)[0] in dotnet_roots
                strategies.add("dotnet-namespace" if targets or local else "external")
                if targets:
                    resolved_by_file[rel].extend((spec, target, "dotnet-namespace") for target in targets)
                elif local:
                    unresolved_by_file[rel].append({"importer": rel, "specifier": spec, "reason": "local-import-unresolved", "strategy": "dotnet-namespace"})

    reverse_targets: dict[str, set[str]] = defaultdict(set)
    for importer, values in resolved_by_file.items():
        for _, target, _ in values:
            reverse_targets[target].add(importer)

    changed_set = set(changed_production)
    queue: deque[str] = deque()
    context: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, str]] = []
    unresolved: list[dict[str, str]] = []
    for rel in changed_production:
        if not (repo / rel).is_file() and rel not in virtual:
            continue
        context[rel] = {
            "path": rel,
            "changed": True,
            "deleted": rel in virtual and not (repo / rel).is_file(),
            "relation": "changed",
            "stack": _kind(PurePosixPath(rel).suffix.lower()),
        }
        if PurePosixPath(rel).suffix.lower() in SUPPORTED_SOURCE_EXTENSIONS:
            queue.append(rel)

    edge_keys: set[tuple[str, str, str, str]] = set()
    while queue:
        if len(context) > MAX_FILES:
            raise RuntimeError(f"runtime graph exceeded {MAX_FILES} files")
        current = queue.popleft()
        unresolved.extend(unresolved_by_file.get(current, []))
        for spec, target, strategy in resolved_by_file.get(current, []):
            key = (current, target, spec, "dependency")
            if key not in edge_keys:
                edge_keys.add(key)
                edges.append({"from": current, "to": target, "specifier": spec, "direction": "dependency", "strategy": strategy})
            if target not in context:
                context[target] = {
                    "path": target,
                    "changed": target in changed_set,
                    "relation": "dependency",
                    "stack": _kind(PurePosixPath(target).suffix.lower()),
                }
                queue.append(target)
        for caller in sorted(reverse_targets.get(current, set())):
            key = (caller, current, "<reverse-caller>", "caller")
            if key not in edge_keys:
                edge_keys.add(key)
                edges.append({"from": caller, "to": current, "specifier": "<reverse-caller>", "direction": "caller", "strategy": "reverse-index"})
            if caller not in context:
                context[caller] = {
                    "path": caller,
                    "changed": caller in changed_set,
                    "relation": "caller",
                    "stack": _kind(PurePosixPath(caller).suffix.lower()),
                }
                queue.append(caller)

    unsupported_changed = [
        rel for rel in changed_production
        if ((repo / rel).is_file() or rel in virtual)
        and PurePosixPath(rel).suffix.lower() not in SNAPSHOT_EXTENSIONS
    ]
    # De-duplicate unresolved records discovered through multiple paths.
    unique_unresolved: dict[tuple[str, str, str], dict[str, str]] = {}
    for item in unresolved:
        unique_unresolved[(item["importer"], item["specifier"], item.get("strategy", ""))] = item
    unresolved = sorted(unique_unresolved.values(), key=lambda item: (item["importer"], item["specifier"]))
    coverage = {
        "schema_version": 2,
        "supported_stacks": ["javascript-typescript", "python", "go", "jvm", "dotnet"],
        "detected_stacks": sorted({item["stack"] for item in context.values()}),
        "resolver_strategies": sorted(strategies),
        "forward_dependencies": sum(1 for edge in edges if edge["direction"] == "dependency"),
        "reverse_callers": sum(1 for edge in edges if edge["direction"] == "caller"),
        "unresolved_local_imports": len(unresolved),
        "unsupported_changed_files": unsupported_changed,
        "configuration_errors": js_config_errors,
        "complete": not unsupported_changed and not unresolved and not js_config_errors,
        "limitations": [],
    }
    if unresolved:
        coverage["limitations"].append("one or more imports classified as local could not be resolved")
    if unsupported_changed:
        coverage["limitations"].append("changed production files use unsupported source formats")
    if js_config_errors:
        coverage["limitations"].append("one or more JavaScript/TypeScript resolver configurations could not be parsed or resolved")

    importers: dict[str, set[str]] = defaultdict(set)
    callers: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        if edge["direction"] == "dependency":
            importers[edge["to"]].add(edge["from"])
        else:
            callers[edge["to"]].add(edge["from"])
    files: list[dict[str, Any]] = []
    for rel in sorted(context):
        item = dict(context[rel])
        item["importers"] = sorted(importers.get(rel, set()))
        item["callers"] = sorted(callers.get(rel, set()))
        files.append(item)
    edges.sort(key=lambda item: (item["direction"], item["from"], item["to"], item["specifier"]))
    return files, edges, unresolved, coverage
