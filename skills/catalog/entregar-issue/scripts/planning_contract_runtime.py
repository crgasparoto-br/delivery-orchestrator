#!/usr/bin/env python3
"""Lightweight runtime checks for the hot controller path.

Full JSON Schema validation remains available in ecosystem tests and final gates.
These checks mirror the controller-context invariants without importing jsonschema
for every small controller operation.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

CONTRACT_VERSION = '2026-08-06.2'
METRIC_NAMES = (
    'issue_full_reads', 'documentation_full_scans', 'subskill_calls',
    'full_suites', 'freezes', 'remote_collections', 'reused_stages',
    'avoidable_invalidations',
)


def _fail(message: str) -> None:
    raise ValueError(message)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_string(payload: dict[str, Any], key: str, minimum: int = 1) -> None:
    value = payload.get(key)
    if not isinstance(value, str) or len(value) < minimum:
        _fail(f'{key} must be a string with length >= {minimum}')


def _require_time(value: Any, field: str) -> None:
    if not isinstance(value, str) or not value:
        _fail(f'{field} must be an ISO-8601 string')
    normalized = value.replace('Z', '+00:00')
    try:
        datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f'{field} must be an ISO-8601 string') from exc


def validate_controller_context(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        _fail('controller context must be an object')
    if payload.get('schema_version') != 1:
        _fail('schema_version must be 1')
    if payload.get('contract_version') != CONTRACT_VERSION:
        _fail(f'contract_version must be {CONTRACT_VERSION}')
    _require_string(payload, 'controller_context_id', 8)
    for key in ('controller_revision', 'controller_cycle', 'controller_cycle_limit'):
        value = payload.get(key)
        if not _is_int(value):
            _fail(f'{key} must be an integer')
    if payload['controller_revision'] < 1:
        _fail('controller_revision must be >= 1')
    if not 1 <= payload['controller_cycle'] <= 10:
        _fail('controller_cycle must be between 1 and 10')
    if not 1 <= payload['controller_cycle_limit'] <= 10:
        _fail('controller_cycle_limit must be between 1 and 10')
    _require_string(payload, 'repository', 3)
    _require_string(payload, 'repository_path')
    _require_string(payload, 'base_ref')
    _require_string(payload, 'branch')
    issue = payload.get('issue')
    if not _is_int(issue) or issue < 1:
        _fail('issue must be an integer >= 1')
    pull_request = payload.get('pull_request')
    if pull_request is not None and (not _is_int(pull_request) or pull_request < 1):
        _fail('pull_request must be null or an integer >= 1')

    identity = payload.get('identity')
    if not isinstance(identity, dict):
        _fail('identity must be an object')
    for key in ('head_sha', 'base_sha', 'merge_preview_sha'):
        value = identity.get(key)
        if value is not None and not isinstance(value, str):
            _fail(f'identity.{key} must be a string or null')
    _require_time(identity.get('captured_at'), 'identity.captured_at')
    _require_time(identity.get('observed_at'), 'identity.observed_at')

    permissions = payload.get('permissions')
    if not isinstance(permissions, dict):
        _fail('permissions must be an object')
    permission_keys = {
        'may_write_code', 'may_update_issue', 'may_merge',
        'may_execute_destructive_actions',
    }
    if set(permissions) != permission_keys:
        _fail('permissions fields are invalid')
    if any(not isinstance(value, bool) for value in permissions.values()):
        _fail('permissions values must be boolean')
    if permissions['may_merge'] or permissions['may_execute_destructive_actions']:
        _fail('merge and destructive actions must remain disabled')

    policy = payload.get('workflow_policy')
    if not isinstance(policy, dict):
        _fail('workflow_policy must be an object')
    policy_keys = {
        'workflow_change_authorized', 'manual_approval_workflow_authorized',
        'remote_action_mode', 'publish_policy',
    }
    if set(policy) != policy_keys:
        _fail('workflow_policy fields are invalid')
    if not isinstance(policy['workflow_change_authorized'], bool):
        _fail('workflow_change_authorized must be boolean')
    if policy['manual_approval_workflow_authorized'] is not False:
        _fail('manual approval workflows must remain disabled')
    if policy['remote_action_mode'] != 'observe-only':
        _fail('remote_action_mode must be observe-only')
    if policy['publish_policy'] != 'single-final-candidate':
        _fail('publish_policy must be single-final-candidate')

    if not isinstance(payload.get('workflow_inventory'), list):
        _fail('workflow_inventory must be an array')
    if not isinstance(payload.get('baseline'), dict):
        _fail('baseline must be an object')
    if not isinstance(payload.get('source_manifest'), dict):
        _fail('source_manifest must be an object')

    metrics = payload.get('metrics')
    if not isinstance(metrics, dict) or set(metrics) != set(METRIC_NAMES):
        _fail('metrics fields are invalid')
    for name in METRIC_NAMES:
        value = metrics[name]
        if not _is_int(value) or value < 0:
            _fail(f'metrics.{name} must be an integer >= 0')

    _require_time(payload.get('created_at'), 'created_at')
    _require_time(payload.get('updated_at'), 'updated_at')


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in '0123456789abcdef' for char in value)
    )


def _require_unique_strings(value: Any, field: str) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        _fail(f'{field} must be a non-empty string array or an empty array')
    if len(value) != len(set(value)):
        _fail(f'{field} must contain unique values')


def validate_execution_plan(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        _fail('execution plan must be an object')
    required = {
        'schema_version', 'contract_version', 'controller_context_id',
        'controller_revision', 'controller_cycle', 'profile', 'risk_signals',
        'applicable_skills', 'required_gates', 'domain_requests',
        'execution_order', 'stages', 'reusable_stages', 'invalidated_stages',
        'context_fingerprints', 'change_classification', 'work_items',
        'work_item_fingerprint', 'internal_plan', 'skill_plan', 'publication',
        'plan_fingerprint', 'generated_at',
    }
    missing = sorted(required - set(payload))
    if missing:
        _fail(f'execution plan missing fields: {missing}')
    if payload['schema_version'] != 2:
        _fail('execution plan schema_version must be 2')
    if payload['contract_version'] != CONTRACT_VERSION:
        _fail(f'execution plan contract_version must be {CONTRACT_VERSION}')
    _require_string(payload, 'controller_context_id', 8)
    if not _is_int(payload['controller_revision']) or payload['controller_revision'] < 1:
        _fail('controller_revision must be an integer >= 1')
    if not _is_int(payload['controller_cycle']) or not 1 <= payload['controller_cycle'] <= 10:
        _fail('controller_cycle must be between 1 and 10')
    if payload['profile'] not in {'light', 'standard', 'critical'}:
        _fail('profile is invalid')
    for field in (
        'risk_signals', 'applicable_skills', 'required_gates', 'execution_order',
        'reusable_stages', 'invalidated_stages', 'work_items',
    ):
        _require_unique_strings(payload[field], field)
    if not _is_sha256(payload['work_item_fingerprint']):
        _fail('work_item_fingerprint must be a lowercase SHA-256')
    fingerprints = payload['context_fingerprints']
    if not isinstance(fingerprints, dict):
        _fail('context_fingerprints must be an object')
    expected_fingerprints = {'identity', 'sources', 'baseline', 'workflows', 'policy', 'permissions'}
    if set(fingerprints) != expected_fingerprints:
        _fail('context_fingerprints fields are invalid')
    if any(not _is_sha256(value) for value in fingerprints.values()):
        _fail('context_fingerprints values must be lowercase SHA-256')
    classification = payload['change_classification']
    classification_fields = {
        'docs_only', 'assets_only', 'generated_only', 'test_only',
        'code_touched', 'runtime_config_touched', 'behavioral_change',
        'hygiene_applicable',
    }
    if not isinstance(classification, dict) or set(classification) != classification_fields:
        _fail('change_classification fields are invalid')
    if any(not isinstance(value, bool) for value in classification.values()):
        _fail('change_classification values must be boolean')

    stages = payload['stages']
    if not isinstance(stages, dict) or list(stages) != payload['execution_order']:
        _fail('stages must follow execution_order')
    reusable = set(payload['reusable_stages'])
    invalidated = set(payload['invalidated_stages'])
    if reusable & invalidated or reusable | invalidated != set(payload['execution_order']):
        _fail('reusable and invalidated stages must partition execution_order')
    for name, stage in stages.items():
        if not isinstance(stage, dict):
            _fail(f'stages.{name} must be an object')
        for key in ('fingerprint', 'input_fingerprint'):
            if not _is_sha256(stage.get(key)):
                _fail(f'stages.{name}.{key} must be a lowercase SHA-256')
        _require_unique_strings(stage.get('depends_on'), f'stages.{name}.depends_on')
        _require_unique_strings(stage.get('invalidated_by'), f'stages.{name}.invalidated_by')
        if not isinstance(stage.get('dependency_fingerprints'), dict):
            _fail(f'stages.{name}.dependency_fingerprints must be an object')
        if any(not _is_sha256(value) for value in stage['dependency_fingerprints'].values()):
            _fail(f'stages.{name}.dependency_fingerprints values are invalid')
        if not isinstance(stage.get('reused'), bool):
            _fail(f'stages.{name}.reused must be boolean')
        if stage['reused'] != (name in reusable):
            _fail(f'stages.{name}.reused disagrees with reusable_stages')

    if not isinstance(payload['domain_requests'], list):
        _fail('domain_requests must be an array')
    for index, request in enumerate(payload['domain_requests']):
        if not isinstance(request, dict) or not _is_sha256(request.get('input_fingerprint')):
            _fail(f'domain_requests[{index}] is invalid')
    if not isinstance(payload['internal_plan'], list):
        _fail('internal_plan must be an array')
    for index, item in enumerate(payload['internal_plan']):
        if not isinstance(item, dict):
            _fail(f'internal_plan[{index}] must be an object')
        if item.get('action') not in {'run', 'reuse-candidate', 'not-applicable', 'conditional'}:
            _fail(f'internal_plan[{index}].action is invalid')
        if not isinstance(item.get('stage'), str) or not item['stage']:
            _fail(f'internal_plan[{index}].stage is required')
        if not isinstance(item.get('reason'), str) or not item['reason']:
            _fail(f'internal_plan[{index}].reason is required')
        if not isinstance(item.get('write_owner'), str) or not item['write_owner']:
            _fail(f'internal_plan[{index}].write_owner is required')
        if not _is_sha256(item.get('input_fingerprint')):
            _fail(f'internal_plan[{index}].input_fingerprint is invalid')
        _require_unique_strings(item.get('requirements'), f'internal_plan[{index}].requirements')
        _require_unique_strings(item.get('paths'), f'internal_plan[{index}].paths')

    if not isinstance(payload['skill_plan'], list):
        _fail('skill_plan must be an array')
    for index, item in enumerate(payload['skill_plan']):
        if not isinstance(item, dict):
            _fail(f'skill_plan[{index}] must be an object')
        if item.get('action') not in {'run', 'reuse-candidate', 'not-applicable', 'conditional'}:
            _fail(f'skill_plan[{index}].action is invalid')
        if not isinstance(item.get('skill'), str) or not item['skill']:
            _fail(f'skill_plan[{index}].skill is required')
        if not isinstance(item.get('reason'), str) or not item['reason']:
            _fail(f'skill_plan[{index}].reason is required')
        if not _is_sha256(item.get('input_fingerprint')):
            _fail(f'skill_plan[{index}].input_fingerprint is invalid')
        _require_unique_strings(item.get('requirements'), f'skill_plan[{index}].requirements')
        _require_unique_strings(item.get('paths'), f'skill_plan[{index}].paths')

    publication = payload['publication']
    if not isinstance(publication, dict) or set(publication) != {'allowed', 'reason'}:
        _fail('publication is invalid')
    if not isinstance(publication['allowed'], bool) or not isinstance(publication['reason'], str):
        _fail('publication fields are invalid')
    if not _is_sha256(payload['plan_fingerprint']):
        _fail('plan_fingerprint must be a lowercase SHA-256')
    _require_time(payload['generated_at'], 'generated_at')


def _require_bool(payload: dict[str, Any], key: str) -> None:
    if not isinstance(payload.get(key), bool):
        _fail(f'{key} must be boolean')


def _require_int(payload: dict[str, Any], key: str, minimum: int = 1, maximum: int | None = None) -> None:
    value = payload.get(key)
    if not _is_int(value) or value < minimum or (maximum is not None and value > maximum):
        suffix = f' and <= {maximum}' if maximum is not None else ''
        _fail(f'{key} must be an integer >= {minimum}{suffix}')


def _require_array_of(value: Any, item_type: type, field: str, *, unique: bool = False, minimum: int = 0) -> None:
    if not isinstance(value, list) or len(value) < minimum or any(not isinstance(item, item_type) for item in value):
        _fail(f'{field} must be an array of {item_type.__name__}')
    if unique and len(value) != len(set(value)):
        _fail(f'{field} must contain unique values')


def validate_execution_context(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        _fail('execution context must be an object')
    allowed = {
        'schema_version', 'contract_version', 'repository', 'repo_path', 'issue',
        'base_ref', 'branch', 'pull_request', 'mode', 'execution_profile',
        'implementation_context_id', 'cycle', 'controller_cycle',
        'controller_state_revision', 'cycle_authority', 'controller_context_sha256',
        'head_sha', 'base_sha', 'merge_preview_sha', 'artifacts_dir',
        'controller_mode', 'controller_context_id', 'controller_cycle_limit',
        'return_control_to', 'workflow_change_authorized',
        'manual_approval_workflow_authorized', 'remote_action_mode',
        'publish_policy', 'permissions',
    }
    unknown = sorted(set(payload) - allowed)
    if unknown:
        _fail(f'execution context has unknown fields: {unknown}')
    required = {
        'schema_version', 'contract_version', 'repository', 'repo_path', 'issue',
        'base_ref', 'branch', 'mode', 'execution_profile',
        'implementation_context_id', 'cycle', 'permissions', 'artifacts_dir',
        'workflow_change_authorized', 'manual_approval_workflow_authorized',
        'remote_action_mode', 'publish_policy',
    }
    missing = sorted(required - set(payload))
    if missing:
        _fail(f'execution context missing fields: {missing}')
    if payload['schema_version'] != 1:
        _fail('execution context schema_version must be 1')
    if payload['contract_version'] != CONTRACT_VERSION:
        _fail(f'execution context contract_version must be {CONTRACT_VERSION}')
    for key, minimum in (
        ('repository', 3), ('repo_path', 1), ('base_ref', 1), ('branch', 1),
        ('mode', 1), ('implementation_context_id', 8), ('artifacts_dir', 1),
    ):
        _require_string(payload, key, minimum)
    _require_int(payload, 'issue')
    _require_int(payload, 'cycle')
    pull_request = payload.get('pull_request')
    if pull_request is not None and (not _is_int(pull_request) or pull_request < 1):
        _fail('pull_request must be null or an integer >= 1')
    if payload['execution_profile'] not in {'light', 'standard', 'critical'}:
        _fail('execution_profile is invalid')
    for key in ('head_sha', 'base_sha', 'merge_preview_sha'):
        if payload.get(key) is not None and not isinstance(payload.get(key), str):
            _fail(f'{key} must be string or null')
    permissions = payload.get('permissions')
    permission_keys = {
        'may_write_code', 'may_update_issue', 'may_merge',
        'may_execute_destructive_actions',
    }
    if not isinstance(permissions, dict) or set(permissions) != permission_keys:
        _fail('permissions fields are invalid')
    if any(not isinstance(value, bool) for value in permissions.values()):
        _fail('permissions values must be boolean')
    _require_bool(payload, 'workflow_change_authorized')
    if payload['manual_approval_workflow_authorized'] is not False:
        _fail('manual approval workflows must remain disabled')
    if payload['remote_action_mode'] != 'observe-only':
        _fail('remote_action_mode must be observe-only')
    if payload['publish_policy'] != 'single-final-candidate':
        _fail('publish_policy must be single-final-candidate')
    controller_mode = payload.get('controller_mode')
    if controller_mode not in {None, 'delivery-single-invocation', 'issue-loop-single-invocation'}:
        _fail('controller_mode is invalid')
    for key in ('controller_context_id', 'return_control_to'):
        value = payload.get(key)
        if value is not None and not isinstance(value, str):
            _fail(f'{key} must be string or null')
    if payload.get('controller_context_id') is not None and len(payload['controller_context_id']) < 8:
        _fail('controller_context_id must have length >= 8')
    for key in ('controller_cycle', 'controller_cycle_limit'):
        value = payload.get(key)
        if value is not None and (not _is_int(value) or not 1 <= value <= 10):
            _fail(f'{key} must be null or between 1 and 10')
    revision = payload.get('controller_state_revision')
    if revision is not None and (not _is_int(revision) or revision < 1):
        _fail('controller_state_revision must be null or >= 1')
    if payload.get('cycle_authority') not in {None, 'entregar-issue', 'orquestrador', 'issue-loop-engineer'}:
        _fail('cycle_authority is invalid')
    context_hash = payload.get('controller_context_sha256')
    if context_hash is not None and not _is_sha256(context_hash):
        _fail('controller_context_sha256 must be null or a lowercase SHA-256')
    if controller_mode in {'delivery-single-invocation', 'issue-loop-single-invocation'}:
        for key in ('controller_cycle', 'controller_state_revision', 'cycle_authority', 'controller_context_sha256'):
            if payload.get(key) is None:
                _fail(f'{key} is required in controller mode')
        allowed_authorities = {'entregar-issue'} if controller_mode == 'delivery-single-invocation' else {'entregar-issue', 'issue-loop-engineer'}
        if payload['cycle_authority'] not in allowed_authorities:
            _fail('cycle_authority is invalid for controller mode')


def _validate_evidence_artifact(value: Any, field: str) -> None:
    if not isinstance(value, dict) or set(value) != {'path', 'sha256'}:
        _fail(f'{field} must contain only path and sha256')
    if not isinstance(value['path'], str) or not value['path']:
        _fail(f'{field}.path is required')
    if not _is_sha256(value['sha256']):
        _fail(f'{field}.sha256 must be a lowercase SHA-256')


def validate_subskill_result(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        _fail('subskill result must be an object')
    allowed = {
        'schema_version', 'contract_version', 'skill', 'mode', 'status',
        'summary', 'requirements', 'findings', 'validations', 'artifacts',
        'changed_files', 'documentation_impacts', 'limitations',
        'requires_refreeze', 'data', 'input_fingerprint', 'reused',
        'reuse_source', 'skip_reason',
    }
    unknown = sorted(set(payload) - allowed)
    if unknown:
        _fail(f'subskill result has unknown fields: {unknown}')
    required = {
        'schema_version', 'contract_version', 'skill', 'mode', 'status',
        'findings', 'validations', 'artifacts', 'changed_files', 'limitations',
        'requires_refreeze', 'input_fingerprint', 'reused',
    }
    missing = sorted(required - set(payload))
    if missing:
        _fail(f'subskill result missing fields: {missing}')
    if payload['schema_version'] != 1:
        _fail('subskill schema_version must be 1')
    if payload['contract_version'] != CONTRACT_VERSION:
        _fail(f'subskill contract_version must be {CONTRACT_VERSION}')
    _require_string(payload, 'skill')
    _require_string(payload, 'mode')
    statuses = {
        'passed', 'passed-with-limitations', 'findings', 'specification-gap',
        'blocked', 'not-applicable', 'no-change', 'contract-mismatch',
    }
    if payload['status'] not in statuses:
        _fail('subskill status is invalid')
    if 'summary' in payload and not isinstance(payload['summary'], str):
        _fail('summary must be a string')
    for field in ('requirements', 'findings', 'validations', 'artifacts', 'documentation_impacts'):
        if field in payload:
            _require_array_of(payload[field], dict, field)
    _require_array_of(payload['changed_files'], str, 'changed_files', unique=True)
    _require_array_of(payload['limitations'], str, 'limitations')
    _require_bool(payload, 'requires_refreeze')
    if 'data' in payload and not isinstance(payload['data'], dict):
        _fail('data must be an object')
    if not _is_sha256(payload['input_fingerprint']):
        _fail('input_fingerprint must be a lowercase SHA-256')
    _require_bool(payload, 'reused')
    if payload['status'] in {'not-applicable', 'no-change', 'contract-mismatch'}:
        if not isinstance(payload.get('skip_reason'), str) or not payload['skip_reason']:
            _fail('skip_reason is required for no-op statuses')
    elif 'skip_reason' in payload and not isinstance(payload['skip_reason'], str):
        _fail('skip_reason must be a string')

    if payload['reused']:
        if payload['changed_files']:
            _fail('reused result must have changed_files=[]')
        if payload['requires_refreeze']:
            _fail('reused result cannot require refreeze')
        source = payload.get('reuse_source')
        if not isinstance(source, dict) or set(source) != {'result_path', 'sha256', 'input_fingerprint'}:
            _fail('reuse_source must contain result_path, sha256 and input_fingerprint')
        if not isinstance(source['result_path'], str) or not source['result_path']:
            _fail('reuse_source.result_path is required')
        if not _is_sha256(source['sha256']):
            _fail('reuse_source.sha256 must be a lowercase SHA-256')
        if not _is_sha256(source['input_fingerprint']):
            _fail('reuse_source.input_fingerprint must be a lowercase SHA-256')
    elif 'reuse_source' in payload:
        _fail('reuse_source is forbidden when reused=false')

    if payload['skill'] == 'auditar-issue' and payload['mode'] == 'controller-adversarial':
        _require_array_of(payload.get('requirements'), dict, 'requirements', minimum=1)
        data = payload.get('data')
        if not isinstance(data, dict):
            _fail('data is required for controller-adversarial audit')
        required_data = {
            'controller_disposition', 'assurance_level', 'release_gate_satisfied',
            'approval_scope', 'verdict', 'requirements', 'blocking_findings',
            'recommendations', 'gates', 'limitations', 'identity',
            'modifications_detected', 'evidence_artifacts',
        }
        missing_data = sorted(required_data - set(data))
        if missing_data:
            _fail(f'controller audit data missing fields: {missing_data}')
        if data['controller_disposition'] not in {'internally-approved', 'remediation-required'}:
            _fail('controller_disposition is invalid')
        if data['assurance_level'] != 'controller-adversarial':
            _fail('assurance_level must be controller-adversarial')
        if data['approval_scope'] != 'internal-only' or data['release_gate_satisfied'] is not False:
            _fail('controller audit approval scope must remain internal-only')
        if data['verdict'] not in {'Aprovado', 'Aprovado com ressalvas', 'Reprovado'}:
            _fail('controller audit verdict is invalid')
        _require_array_of(data['requirements'], dict, 'data.requirements', minimum=1)
        _require_array_of(data['blocking_findings'], dict, 'data.blocking_findings')
        _require_array_of(data['recommendations'], dict, 'data.recommendations')
        _require_array_of(data['gates'], dict, 'data.gates', minimum=1)
        _require_array_of(data['limitations'], dict, 'data.limitations')
        if not isinstance(data['identity'], dict):
            _fail('data.identity must be an object')
        if data['modifications_detected'] is not False:
            _fail('modifications_detected must be false')
        evidence = data['evidence_artifacts']
        expected = {
            'source_manifest', 'requirements_rederivation',
            'coverage_matrix', 'controller_audit_report',
        }
        if not isinstance(evidence, dict) or set(evidence) != expected:
            _fail('evidence_artifacts fields are invalid')
        for name in sorted(expected):
            _validate_evidence_artifact(evidence[name], f'data.evidence_artifacts.{name}')
        if payload['requires_refreeze']:
            _fail('controller-adversarial audit cannot require refreeze')
