#!/usr/bin/env python3
"""Create a deterministic, risk-proportional execution and delegation plan."""
from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from planning_contract_runtime import validate_controller_context, validate_execution_plan

ROOT = Path(__file__).resolve().parents[1]
CRITICAL = {
    'authorization', 'privacy', 'multi-tenant', 'migration', 'concurrency',
    'parser', 'decoder', 'retry', 'fallback', 'cancellation', 'continuation',
    'provider',
}
SIGNAL_KEYWORDS = {
    'authorization': ('authorization', 'permission', 'role', 'rbac', 'autorizacao', 'permissao'),
    'privacy': ('privacy', 'secret', 'credential', 'pii', 'privacidade', 'segredo', 'credencial'),
    'multi-tenant': ('multi-tenant', 'tenant', 'workspace', 'organizacao'),
    'migration': ('migration', 'backfill', 'schema change', 'migracao'),
    'concurrency': ('concurrency', 'race', 'lock', 'atomic', 'concorrencia', 'atomico'),
    'parser': ('parser', 'parse', 'decoder', 'deserialize', 'lexer', 'tokenizer', 'decodificador'),
    'retry': ('retry', 'retries', 'retentativa'),
    'fallback': ('fallback',),
    'cancellation': ('cancel', 'cancellation', 'cancelamento'),
    'continuation': ('callback', 'webhook', 'queue', 'pending', 'conversation', 'message flow', 'fila', 'pendente', 'conversa', 'mensagem futura'),
    'provider': ('provider', 'sdk', 'external api', 'adapter', 'provedor', 'api externa'),
    'interface': ('interface', 'screen', 'layout', 'button', 'form', 'accessibility', 'responsive', 'tela', 'botao', 'formulario', 'acessibilidade', 'responsivo'),
}
DOC_SUFFIXES = ('.md', '.txt', '.rst', '.adoc')
UI_SUFFIXES = ('.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.html', '.hbs', '.erb')
ASSET_SUFFIXES = ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.pdf')
CODE_SUFFIXES = (
    '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt',
    '.go', '.rs', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp',
    '.swift', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.vue', '.svelte',
)
CONFIG_SUFFIXES = ('.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml')
RUNTIME_CONFIG_NAMES = {
    'package.json', 'pyproject.toml', 'dockerfile', 'compose.yaml',
    'compose.yml', 'tsconfig.json', 'vite.config.ts', 'next.config.js',
}
GENERATED_MARKERS = ('/generated/', '/dist/', '/build/', '/coverage/', '.generated.', '.g.')
TEST_DIR_MARKERS = {'test', 'tests', '__tests__', 'spec', 'specs', 'fixtures'}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError(f'expected object: {path}')
    return value


def load_value(path: Path) -> Any:
    return json.loads(path.read_text(encoding='utf-8'))


def digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def normalize_text(value: str) -> str:
    decomposed = unicodedata.normalize('NFKD', value.lower())
    return ''.join(char for char in decomposed if not unicodedata.combining(char))


def read_changed_files(path: Path) -> list[str]:
    value = load_value(path)
    changed = value.get('changed_files', []) if isinstance(value, dict) else value
    if not isinstance(changed, list) or any(not isinstance(item, str) for item in changed):
        raise ValueError('changed-files must contain a string array')
    return sorted(set(item.strip() for item in changed if item.strip()))


def requirement_parts(item: Any) -> tuple[str | None, str]:
    if isinstance(item, str):
        text = item.strip()
        return (text or None, text)
    if not isinstance(item, dict):
        return (None, '')
    identifier = item.get('id')
    identifier = identifier.strip() if isinstance(identifier, str) and identifier.strip() else None
    text_parts = []
    for key in ('statement', 'text', 'title', 'description', 'acceptance_criteria'):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            text_parts.append(value.strip())
    text = ' '.join(text_parts)
    return (identifier or (text if text else None), text)


def read_requirements(path: Path | None) -> tuple[list[str], str]:
    if path is None:
        return [], ''
    value = load_value(path)
    items = value.get('requirements', []) if isinstance(value, dict) else value
    if not isinstance(items, list):
        raise ValueError('requirements must be an array or an object containing requirements')
    references: list[str] = []
    texts: list[str] = []
    for item in items:
        reference, text = requirement_parts(item)
        if reference:
            references.append(reference)
        if text:
            texts.append(text)
    return sorted(set(references)), ' '.join(texts)


def read_work_items(path: Path | None) -> tuple[list[str], list[str]]:
    if path is None:
        return [], []
    value = load_value(path)
    if isinstance(value, dict):
        for key in ('work_items', 'findings', 'items'):
            if key in value:
                value = value[key]
                break
    if not isinstance(value, list):
        raise ValueError('work-items must be an array or an object containing work_items/findings')
    result: list[str] = []
    paths: set[str] = set()
    for item in value:
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
        elif isinstance(item, dict):
            reference = item.get('fingerprint') or item.get('id') or item.get('name') or 'work-item'
            result.append(f'{reference}:{digest(item)}')
            raw_paths = item.get('paths', [])
            if isinstance(raw_paths, list):
                paths.update(str(value).strip() for value in raw_paths if str(value).strip())
    return sorted(set(result)), sorted(paths)


def infer_signals(explicit: set[str], paths: list[str], requirement_text: str) -> set[str]:
    signals = set(explicit)
    corpus = normalize_text(' '.join(paths) + ' ' + requirement_text)
    for signal, keywords in SIGNAL_KEYWORDS.items():
        if any(normalize_text(keyword) in corpus for keyword in keywords):
            signals.add(signal)
    return signals


def read_domain_requests(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        return []
    value = load_value(path)
    items = value.get('domain_requests', []) if isinstance(value, dict) else value
    if not isinstance(items, list):
        raise ValueError('domain-requests must be an array or an object containing domain_requests')
    return [item for item in items if isinstance(item, dict)]


def normalize_domain_request(item: dict[str, Any]) -> dict[str, Any]:
    skill = item.get('skill')
    if not isinstance(skill, str) or not skill.strip():
        raise ValueError('domain request skill is required')
    raw_requirements = item.get('requirements', [])
    if not isinstance(raw_requirements, list):
        raise ValueError('domain request requirements must be an array')
    requirements = sorted(set(str(value).strip() for value in raw_requirements if str(value).strip()))
    raw_paths = item.get('paths', [])
    if not isinstance(raw_paths, list):
        raise ValueError('domain request paths must be an array')
    paths = sorted(set(str(value).strip() for value in raw_paths if str(value).strip()))
    reason = item.get('reason', 'domain-impact')
    if not isinstance(reason, str) or not reason.strip():
        reason = 'domain-impact'
    payload = {
        'skill': skill.strip(),
        'requirements': requirements,
        'paths': paths,
        'reason': reason.strip(),
    }
    payload['input_fingerprint'] = digest({
        'skill': payload['skill'],
        'requirements': payload['requirements'],
        'paths': payload['paths'],
    })
    return payload


def deduplicate_domain_requests(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for item in items:
        normalized = normalize_domain_request(item)
        key = (normalized['skill'], normalized['input_fingerprint'])
        if key not in by_key:
            by_key[key] = normalized
            continue
        reasons = sorted(set(by_key[key]['reason'].split('; ') + normalized['reason'].split('; ')))
        by_key[key]['reason'] = '; '.join(reasons)
    return sorted(by_key.values(), key=lambda item: (item['skill'], item['input_fingerprint']))


def is_test_path(path: str) -> bool:
    parts = [part for part in path.replace('\\', '/').lower().split('/') if part]
    name = parts[-1] if parts else ''
    return (
        any(part in TEST_DIR_MARKERS for part in parts[:-1])
        or name.startswith('test_')
        or '.test.' in name
        or '.spec.' in name
        or name.endswith('_test.py')
    )


def is_generated_path(path: str) -> bool:
    normalized = '/' + path.replace('\\', '/').lower().lstrip('/')
    return any(marker in normalized for marker in GENERATED_MARKERS)


def classify_changes(changed: list[str], signals: set[str]) -> dict[str, bool]:
    lower_paths = [item.lower() for item in changed]
    docs_only = bool(changed) and all(
        path.endswith(DOC_SUFFIXES) or '/docs/' in f'/{path}' for path in lower_paths
    )
    if not changed and signals & {'documentation-only', 'docs-only'}:
        docs_only = True
    assets_only = bool(changed) and all(path.endswith(ASSET_SUFFIXES) for path in lower_paths)
    generated_only = bool(changed) and all(is_generated_path(path) for path in lower_paths)
    test_only = bool(changed) and all(is_test_path(path) for path in lower_paths)
    code_touched = any(path.endswith(CODE_SUFFIXES) for path in lower_paths)
    runtime_config_touched = any(
        path.endswith(CONFIG_SUFFIXES)
        or Path(path).name in RUNTIME_CONFIG_NAMES
        or '/migrations/' in f'/{path}'
        or '/schema/' in f'/{path}'
        for path in lower_paths
    )
    behavioral_change = code_touched or runtime_config_touched or bool(signals & (CRITICAL | {'interface'}))
    if docs_only and not signals & CRITICAL:
        behavioral_change = False
    hygiene_applicable = code_touched and not generated_only and not test_only
    return {
        'docs_only': docs_only,
        'assets_only': assets_only,
        'generated_only': generated_only,
        'test_only': test_only,
        'code_touched': code_touched,
        'runtime_config_touched': runtime_config_touched,
        'behavioral_change': behavioral_change,
        'hygiene_applicable': hygiene_applicable,
    }


def semantic_identity(identity: dict[str, Any]) -> dict[str, Any]:
    return {
        'head_sha': identity.get('head_sha'),
        'base_sha': identity.get('base_sha'),
        'merge_preview_sha': identity.get('merge_preview_sha'),
    }


def build_stages(
    deps: dict[str, Any],
    stage_inputs: dict[str, Any],
    previous: dict[str, Any] | None,
) -> tuple[dict[str, Any], list[str], list[str], list[str]]:
    stages: dict[str, Any] = {}
    order: list[str] = []
    previous_stages = previous.get('stages', {}) if previous else {}
    for name, cfg in deps['stages'].items():
        dependencies = cfg.get('depends_on', [])
        missing = [dependency for dependency in dependencies if dependency not in stages]
        if missing:
            raise ValueError(f'stage dependency graph is not topological for {name}: {missing}')
        input_fingerprint = digest({'stage': name, 'inputs': stage_inputs[name]})
        dependency_fingerprints = {
            dependency: stages[dependency]['fingerprint'] for dependency in dependencies
        }
        fingerprint = digest({
            'stage': name,
            'input_fingerprint': input_fingerprint,
            'dependency_fingerprints': dependency_fingerprints,
        })
        previous_item = previous_stages.get(name, {}) if isinstance(previous_stages, dict) else {}
        reused = previous_item.get('fingerprint') == fingerprint
        invalidated_by: list[str] = []
        if not previous:
            invalidated_by.append('no-previous-plan')
        elif not reused:
            if previous_item.get('input_fingerprint') != input_fingerprint:
                invalidated_by.append('stage-input-changed')
            previous_dependencies = previous_item.get('dependency_fingerprints', {})
            for dependency, dependency_fingerprint in dependency_fingerprints.items():
                if previous_dependencies.get(dependency) != dependency_fingerprint:
                    invalidated_by.append(f'dependency-changed:{dependency}')
            if not invalidated_by:
                invalidated_by.append('fingerprint-format-or-contract-changed')
        stages[name] = {
            'fingerprint': fingerprint,
            'input_fingerprint': input_fingerprint,
            'depends_on': dependencies,
            'dependency_fingerprints': dependency_fingerprints,
            'reused': reused,
            'invalidated_by': invalidated_by,
        }
        order.append(name)
    reusable = [name for name in order if stages[name]['reused']]
    invalidated = [name for name in order if not stages[name]['reused']]
    return stages, order, reusable, invalidated


def stage_action(stages: dict[str, Any], stage: str, applicable: bool = True) -> str:
    if not applicable:
        return 'not-applicable'
    return 'reuse-candidate' if stages[stage]['reused'] else 'run'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--controller-context', required=True)
    parser.add_argument('--changed-files', required=True, help='JSON array or object with changed_files')
    parser.add_argument('--requirements', help='JSON array or object with requirements')
    parser.add_argument('--work-items', help='JSON array or object with work_items/findings')
    parser.add_argument('--scope-paths', help='Stable planned implementation paths; observed changed files are outputs, not implementation inputs')
    parser.add_argument('--domain-requests', help='JSON array or object with domain_requests')
    parser.add_argument('--signal', action='append', default=[])
    parser.add_argument('--previous-plan')
    parser.add_argument('--local-green', action='store_true')
    parser.add_argument('--material-change', action='store_true')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    context = load_object(Path(args.controller_context).resolve())
    validate_controller_context(context)
    changed = read_changed_files(Path(args.changed_files).resolve())
    requirements, requirement_text = read_requirements(Path(args.requirements).resolve() if args.requirements else None)
    work_items, work_item_paths = read_work_items(Path(args.work_items).resolve() if args.work_items else None)
    work_item_fingerprint = digest(work_items)
    previous = load_object(Path(args.previous_plan).resolve()) if args.previous_plan else None
    if args.scope_paths:
        implementation_scope = read_changed_files(Path(args.scope_paths).resolve())
    elif previous:
        prior_scope: list[str] = []
        for item in previous.get('internal_plan', []):
            if isinstance(item, dict) and item.get('stage') == 'implementation':
                raw_paths = item.get('paths', [])
                if isinstance(raw_paths, list):
                    prior_scope = [str(value).strip() for value in raw_paths if str(value).strip()]
                break
        if not prior_scope:
            # Compatibility with execution-plan v2 produced by the former orchestrator.
            for item in previous.get('skill_plan', []):
                if isinstance(item, dict) and item.get('skill') == 'implementar-issue':
                    raw_paths = item.get('paths', [])
                    if isinstance(raw_paths, list):
                        prior_scope = [str(value).strip() for value in raw_paths if str(value).strip()]
                    break
        implementation_scope = sorted(set(prior_scope) | set(work_item_paths))
        if previous.get('work_item_fingerprint') != work_item_fingerprint:
            implementation_scope = sorted(set(implementation_scope) | set(changed))
    else:
        implementation_scope = sorted(set(changed) | set(work_item_paths))
    explicit_signals = {item.strip().lower() for item in args.signal if item.strip()}
    signals = infer_signals(explicit_signals, changed, requirement_text)
    classification = classify_changes(changed, signals)
    lower_paths = [item.lower() for item in changed]

    ui = any(path.endswith(UI_SUFFIXES) for path in lower_paths) or 'interface' in signals
    continuation = 'continuation' in signals
    parser_risk = bool(signals & {'parser', 'decoder'})
    critical = bool(signals & CRITICAL) or parser_risk or continuation
    if (classification['docs_only'] or classification['assets_only']) and not critical:
        profile = 'light'
    elif critical:
        profile = 'critical'
    else:
        profile = 'standard'

    applicable: list[str] = []
    broad_documentation = bool(signals & {'documentation-broad', 'docs-global', 'adr', 'runbook', 'api-docs'})
    broad_documentation = broad_documentation or sum(
        1 for path in lower_paths if path.endswith(DOC_SUFFIXES) or '/docs/' in f'/{path}'
    ) >= 4
    raw_domain_requests = read_domain_requests(Path(args.domain_requests).resolve() if args.domain_requests else None)

    def add_heuristic_request(skill: str, reason: str) -> None:
        for request in raw_domain_requests:
            if request.get('skill') != skill:
                continue
            request_paths = request.get('paths', [])
            if isinstance(request_paths, list) and sorted(set(request_paths)) == changed:
                existing_requirements = request.get('requirements', [])
                if not isinstance(existing_requirements, list):
                    existing_requirements = []
                request['requirements'] = sorted(set(existing_requirements) | set(requirements))
                existing_reason = request.get('reason', 'domain-impact')
                request['reason'] = f'{existing_reason}; {reason}'
                return
        raw_domain_requests.append({
            'skill': skill,
            'requirements': requirements,
            'reason': reason,
            'paths': changed,
        })

    if ui:
        applicable.append('design-interface')
        add_heuristic_request('design-interface', 'visible-interface-impact')
    if continuation:
        applicable.append('fluxos-conversacionais')
        add_heuristic_request('fluxos-conversacionais', 'continued-state-impact')
    domain_requests = deduplicate_domain_requests(raw_domain_requests)
    applicable.extend(item['skill'] for item in domain_requests)
    if broad_documentation:
        applicable.append('documentacao-repositorio')
        add_heuristic_request('documentacao-repositorio', 'broad-documentation-impact')

    gates = ['contract', 'documentation', 'working-tree', 'identity']
    if classification['behavioral_change']:
        gates.extend(['focused-tests', 'final-suite', 'regression'])
    if profile in {'standard', 'critical'} and classification['behavioral_change']:
        gates.append('negative-controls')
    if profile == 'critical':
        gates.append('critical-risk-family')
    if parser_risk:
        gates.append('input-parser-controls')
    if ui:
        gates.append('visual')

    context_fingerprints = {
        'identity': digest(semantic_identity(context['identity'])),
        'sources': digest(context['source_manifest']),
        'baseline': digest(context['baseline']),
        'workflows': digest(context['workflow_inventory']),
        'policy': digest(context['workflow_policy']),
        'permissions': digest(context['permissions']),
    }
    deps = load_object(ROOT / 'contracts/stage-dependencies.json')
    stage_inputs = {
        'preflight': [
            context['contract_version'], context['controller_context_id'],
            context['repository'], context['repository_path'], context['issue'],
            context['base_ref'], context['branch'], context.get('pull_request'),
            context_fingerprints['permissions'], context_fingerprints['policy'],
        ],
        'contract': [context['issue'], context_fingerprints['sources'], requirements],
        # Observed changed files are implementation outputs. Keeping them out of this
        # fingerprint prevents a successful edit from invalidating its own stage.
        'implementation': [implementation_scope, requirements, work_item_fingerprint],
        'documentation': [changed, classification['docs_only'], requirements, work_item_fingerprint],
        'domain-validation': [domain_requests, profile, work_item_fingerprint],
        'hygiene': [changed, classification['hygiene_applicable'], work_item_fingerprint],
        'final-gate': [sorted(set(gates)), profile, context_fingerprints['baseline'], classification],
        'freeze': [semantic_identity(context['identity'])],
        'remote-gate': [context_fingerprints['policy'], context_fingerprints['workflows'], context.get('pull_request')],
        'audit': [semantic_identity(context['identity']), profile, requirements, work_item_fingerprint],
        'decision': [context['controller_cycle'], profile],
    }
    missing_stage_inputs = set(deps['stages']) - set(stage_inputs)
    if missing_stage_inputs:
        raise ValueError(f'missing stage inputs: {sorted(missing_stage_inputs)}')
    stages, execution_order, reusable, invalidated = build_stages(deps, stage_inputs, previous)

    internal_plan: list[dict[str, Any]] = [
        {
            'stage': 'implementation',
            'action': stage_action(stages, 'implementation', True),
            'reason': 'internal implementation work for the current contract',
            'input_fingerprint': stages['implementation']['fingerprint'],
            'requirements': requirements,
            'paths': implementation_scope,
            'write_owner': 'entregar-issue',
        },
        {
            'stage': 'documentation-delta',
            'action': stage_action(stages, 'documentation', not broad_documentation),
            'reason': 'small documentation updates remain inside the delivery controller' if not broad_documentation else 'broad documentation delegated once to documentacao-repositorio',
            'input_fingerprint': stages['documentation']['fingerprint'],
            'requirements': requirements,
            'paths': changed,
            'write_owner': 'entregar-issue' if not broad_documentation else 'documentacao-repositorio',
        },
        {
            'stage': 'hygiene',
            'action': stage_action(stages, 'hygiene', classification['hygiene_applicable']),
            'reason': 'internal focused safe-fix inspection for touched code' if classification['hygiene_applicable'] else 'no eligible executable code outside generated or test-only paths',
            'input_fingerprint': stages['hygiene']['fingerprint'],
            'requirements': requirements,
            'paths': changed,
            'write_owner': 'entregar-issue',
        },
    ]

    skill_plan: list[dict[str, Any]] = [{
        'skill': 'revisar-issue',
        'action': 'conditional',
        'reason': 'run only when readiness has a material decision gap',
        'input_fingerprint': digest([context_fingerprints['sources'], requirements]),
        'requirements': requirements,
        'paths': [],
    }]
    for request in domain_requests:
        action = stage_action(stages, 'domain-validation', True)
        skill_plan.append({
            'skill': request['skill'],
            'action': action,
            'reason': request['reason'],
            'input_fingerprint': digest([stages['domain-validation']['fingerprint'], request['input_fingerprint']]),
            'requirements': request['requirements'],
            'paths': request['paths'],
        })
    skill_plan.sort(key=lambda item: (item['skill'], item['input_fingerprint']))

    publication_allowed = bool(args.local_green and args.material_change)
    stable_plan = {
        'schema_version': 2,
        'contract_version': context['contract_version'],
        'controller_context_id': context['controller_context_id'],
        'controller_revision': context['controller_revision'],
        'controller_cycle': context['controller_cycle'],
        'profile': profile,
        'risk_signals': sorted(signals),
        'applicable_skills': sorted(set(applicable)),
        'required_gates': sorted(set(gates)),
        'domain_requests': domain_requests,
        'execution_order': execution_order,
        'stages': stages,
        'reusable_stages': reusable,
        'invalidated_stages': invalidated,
        'context_fingerprints': context_fingerprints,
        'change_classification': classification,
        'work_items': work_items,
        'work_item_fingerprint': work_item_fingerprint,
        'internal_plan': internal_plan,
        'skill_plan': skill_plan,
        'publication': {
            'allowed': publication_allowed,
            'reason': 'material locally-green candidate' if publication_allowed else 'requires material change and local green gates',
        },
    }
    plan = dict(stable_plan)
    plan['plan_fingerprint'] = digest(stable_plan)
    plan['generated_at'] = now()
    validate_execution_plan(plan)
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
