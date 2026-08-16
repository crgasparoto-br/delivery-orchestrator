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
