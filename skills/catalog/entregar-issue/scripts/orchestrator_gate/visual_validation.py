from __future__ import annotations

from typing import Any

ROLE_KEYS = {
    "button": {"enter", "space"},
    "link": {"enter"},
    "checkbox": {"space"},
    "switch": {"space"},
    "radio": {"space"},
    "tab": {"arrowleft", "arrowright"},
    "option": {"arrowup", "arrowdown"},
    "menuitem": {"enter"},
    "treeitem": {"arrowleft", "arrowright"},
    "combobox": {"arrowdown", "escape"},
}


def _text(value: Any, label: str, errors: list[str], minimum: int = 1) -> str:
    if not isinstance(value, str) or len(value.strip()) < minimum:
        errors.append(f"{label} must be text with at least {minimum} characters")
        return ""
    return value.strip()


def _list_of_texts(value: Any, label: str, errors: list[str], *, nonempty: bool = True) -> list[str]:
    if not isinstance(value, list) or (nonempty and not value) or any(not isinstance(item, str) or not item.strip() for item in value):
        errors.append(f"{label} must be {'a non-empty ' if nonempty else 'a '}list of texts")
        return []
    if len(value) != len(set(value)):
        errors.append(f"{label} contains duplicates")
    return [item.strip() for item in value]


def validate_visual_contract(contract: Any, errors: list[str]) -> dict[str, Any]:
    if not isinstance(contract, dict):
        errors.append("risk_profile.visual_contract must be an object")
        return {}
    routes = _list_of_texts(contract.get("routes"), "visual_contract.routes", errors)
    _list_of_texts(contract.get("validator_paths"), "visual_contract.validator_paths", errors)
    _list_of_texts(contract.get("workflow_paths"), "visual_contract.workflow_paths", errors, nonempty=False)
    _list_of_texts(contract.get("documentation_paths"), "visual_contract.documentation_paths", errors)

    def validate_surfaces(field: str, rationale_field: str, validator) -> None:
        values = contract.get(field)
        if not isinstance(values, list):
            errors.append(f"visual_contract.{field} must be a list")
            return
        if not values:
            _text(contract.get(rationale_field), f"visual_contract.{rationale_field}", errors, 20)
            return
        seen: set[tuple[str, str]] = set()
        for index, item in enumerate(values):
            if not isinstance(item, dict):
                errors.append(f"visual_contract.{field}[{index}] must be an object")
                continue
            route = _text(item.get("route"), f"visual_contract.{field}[{index}].route", errors)
            name = _text(item.get("name"), f"visual_contract.{field}[{index}].name", errors)
            if route and route not in routes:
                errors.append(f"visual_contract.{field}[{index}] references unknown route {route}")
            key = (route, name)
            if key in seen:
                errors.append(f"visual_contract.{field} duplicates {route}/{name}")
            seen.add(key)
            validator(item, index)

    controls = contract.get("controls")
    if not isinstance(controls, list):
        errors.append("visual_contract.controls must be a list")
    elif not controls:
        _text(contract.get("controls_rationale"), "visual_contract.controls_rationale", errors, 20)
    else:
        seen_controls: set[tuple[str, str]] = set()
        for index, control in enumerate(controls):
            if not isinstance(control, dict):
                errors.append(f"visual_contract.controls[{index}] must be an object")
                continue
            route = _text(control.get("route"), f"visual_contract.controls[{index}].route", errors)
            name = _text(control.get("name"), f"visual_contract.controls[{index}].name", errors)
            _text(control.get("selector"), f"visual_contract.controls[{index}].selector", errors)
            role = _text(control.get("control_role"), f"visual_contract.controls[{index}].control_role", errors)
            if route and route not in routes:
                errors.append(f"visual_contract.controls[{index}] references unknown route {route}")
            if role not in ROLE_KEYS and not control.get("required_keys"):
                errors.append(f"visual_contract.controls[{index}] unsupported role {role!r} requires explicit required_keys")
            if control.get("required_keys") is not None:
                _list_of_texts(control.get("required_keys"), f"visual_contract.controls[{index}].required_keys", errors)
            key = (route, name)
            if key in seen_controls:
                errors.append(f"visual_contract.controls duplicates {route}/{name}")
            seen_controls.add(key)

    def dynamic(item: dict[str, Any], index: int) -> None:
        _text(item.get("selector"), f"visual_contract.dynamic_surfaces[{index}].selector", errors)
        if not isinstance(item.get("single_writer_required"), bool):
            errors.append(f"visual_contract.dynamic_surfaces[{index}].single_writer_required must be boolean")

    def table(item: dict[str, Any], index: int) -> None:
        _text(item.get("selector"), f"visual_contract.table_surfaces[{index}].selector", errors)
        if item.get("rowcount_policy") not in {"native-dom", "explicit-total"}:
            errors.append(f"visual_contract.table_surfaces[{index}].rowcount_policy invalid")

    def dialog(item: dict[str, Any], index: int) -> None:
        _text(item.get("selector"), f"visual_contract.dialog_surfaces[{index}].selector", errors)
        if item.get("description_required") is not None and not isinstance(item.get("description_required"), bool):
            errors.append(f"visual_contract.dialog_surfaces[{index}].description_required must be boolean")

    validate_surfaces("dynamic_surfaces", "dynamic_surfaces_rationale", dynamic)
    validate_surfaces("table_surfaces", "table_surfaces_rationale", table)
    validate_surfaces("dialog_surfaces", "dialog_surfaces_rationale", dialog)
    return contract


def validate_visual_metrics(metrics: dict[str, Any], head_sha: str, contract: dict[str, Any], errors: list[str]) -> None:
    if metrics.get("schema_version") != 2:
        errors.append("visual metrics schema_version must be 2")
    if metrics.get("head_sha") != head_sha:
        errors.append("visual metrics SHA mismatch")
    routes = metrics.get("routes") or []
    if not isinstance(routes, list) or not routes:
        errors.append("visual metrics routes must be a non-empty list")
        return
    by_route: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(routes):
        if not isinstance(item, dict) or not isinstance(item.get("route"), str):
            errors.append(f"visual metrics routes[{index}] invalid")
            continue
        if item["route"] in by_route:
            errors.append(f"visual metrics duplicates route {item['route']}")
        by_route[item["route"]] = item
    expected_routes = contract.get("routes") or []
    unexpected = sorted(set(by_route) - set(expected_routes))
    if unexpected:
        errors.append(f"visual metrics contains unexpected routes: {unexpected}")
    for route_name in expected_routes:
        route = by_route.get(route_name)
        if not isinstance(route, dict):
            errors.append(f"visual route missing: {route_name}")
            continue
        viewports = route.get("viewports") or []
        if not isinstance(viewports, list) or len(set(viewports)) < 3:
            errors.append(f"visual route {route_name} requires three distinct viewports")
        if route.get("long_content_or_zoom") is not True or route.get("keyboard_only") is not True:
            errors.append(f"visual route {route_name} lacks zoom/long-content or keyboard-only evidence")
        tree = route.get("accessibility_tree") or {}
        if tree.get("captured") is not True or tree.get("expected_roles_present") is not True:
            errors.append(f"visual route {route_name} accessibility tree incomplete")
        interactions = {
            item.get("name"): item
            for item in route.get("control_interactions") or []
            if isinstance(item, dict) and item.get("name")
        }
        for control in contract.get("controls") or []:
            if control.get("route") != route_name:
                continue
            name = control.get("name")
            role = control.get("control_role")
            interaction = interactions.get(name)
            required = {
                str(value).lower()
                for value in (control.get("required_keys") or ROLE_KEYS.get(role, set()))
            }
            if not required:
                errors.append(f"visual control {route_name}/{name} has no required keyboard behavior")
                continue
            if not isinstance(interaction, dict):
                errors.append(f"visual control interaction missing: {route_name}/{name}")
                continue
            observed = {str(value).lower() for value in interaction.get("keys_passed") or []}
            missing = required - observed
            if missing:
                errors.append(f"visual control {route_name}/{name} missing keys: {sorted(missing)}")

        dynamic_by_name = {
            item.get("name"): item
            for item in route.get("dynamic_surfaces") or []
            if isinstance(item, dict) and item.get("name")
        }
        for surface in contract.get("dynamic_surfaces") or []:
            if surface.get("route") != route_name:
                continue
            observed = dynamic_by_name.get(surface.get("name"))
            if not isinstance(observed, dict):
                errors.append(f"dynamic surface missing: {route_name}/{surface.get('name')}")
                continue
            if surface.get("single_writer_required") and observed.get("writer_count") != 1:
                errors.append(f"dynamic surface writer count invalid: {route_name}/{surface.get('name')}")
            actions = observed.get("actions") or []
            if not isinstance(actions, list) or not actions:
                errors.append(f"dynamic surface actions missing: {route_name}/{surface.get('name')}")
                continue
            for action in actions:
                if not isinstance(action, dict):
                    errors.append(f"dynamic surface action invalid: {route_name}/{surface.get('name')}")
                    continue
                observed_count = action.get("observed_mutations")
                maximum = action.get("max_mutations")
                if not isinstance(observed_count, int) or not isinstance(maximum, int) or observed_count > maximum:
                    errors.append(f"dynamic surface mutations exceed/omit maximum: {route_name}/{surface.get('name')}")
                if not isinstance(action.get("messages"), list):
                    errors.append(f"dynamic surface messages invalid: {route_name}/{surface.get('name')}")
                _text(action.get("final_text"), f"dynamic surface final_text {route_name}/{surface.get('name')}", errors)

        tables_by_name = {
            item.get("name"): item
            for item in route.get("table_surfaces") or []
            if isinstance(item, dict) and item.get("name")
        }
        for table in contract.get("table_surfaces") or []:
            if table.get("route") != route_name:
                continue
            observed = tables_by_name.get(table.get("name"))
            if not isinstance(observed, dict):
                errors.append(f"table surface missing: {route_name}/{table.get('name')}")
                continue
            if observed.get("roles_present") is not True:
                errors.append(f"table roles missing: {route_name}/{table.get('name')}")
            if not isinstance(observed.get("dom_row_count"), int) or not isinstance(observed.get("header_row_count"), int):
                errors.append(f"table row counts invalid: {route_name}/{table.get('name')}")
            policy = table.get("rowcount_policy")
            if policy == "native-dom" and observed.get("aria_rowcount") is not None:
                errors.append(f"aria_rowcount must be omitted: {route_name}/{table.get('name')}")
            if policy == "explicit-total" and observed.get("aria_rowcount") != observed.get("semantic_total_rows"):
                errors.append(f"aria_rowcount mismatch: {route_name}/{table.get('name')}")

        dialogs_by_name = {
            item.get("name"): item
            for item in route.get("dialog_surfaces") or []
            if isinstance(item, dict) and item.get("name")
        }
        for dialog in contract.get("dialog_surfaces") or []:
            if dialog.get("route") != route_name:
                continue
            observed = dialogs_by_name.get(dialog.get("name"))
            if not isinstance(observed, dict):
                errors.append(f"dialog missing: {route_name}/{dialog.get('name')}")
                continue
            required = ["inside_viewport", "labelled", "initial_focus", "escape_closes", "focus_restored"]
            if dialog.get("description_required", True):
                required.append("described")
            for field in required:
                if observed.get(field) is not True:
                    errors.append(f"dialog {route_name}/{dialog.get('name')} missing {field}")
