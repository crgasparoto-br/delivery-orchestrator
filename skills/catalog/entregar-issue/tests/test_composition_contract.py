import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_init_execution_context(tmp_path):
    out = tmp_path / "execution-context.json"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "init_execution_context.py"),
            "--repository",
            "owner/repo",
            "--repo-path",
            "/tmp/repo",
            "--issue",
            "123",
            "--base-ref",
            "main",
            "--branch",
            "issue-123",
            "--profile",
            "critical",
            "--out",
            str(out),
        ],
        check=True,
    )
    payload = json.loads(out.read_text())
    assert payload["execution_profile"] == "critical"
    assert payload["permissions"]["may_merge"] is False
    assert payload["workflow_change_authorized"] is False
    assert payload["manual_approval_workflow_authorized"] is False
    assert payload["remote_action_mode"] == "observe-only"
    assert payload["publish_policy"] == "single-final-candidate"


def test_validate_subskill_result(tmp_path):
    result = tmp_path / "result.json"
    result.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "contract_version": "2026-08-06.2",
                "skill": "implementar-issue",
                "mode": "implementation",
                "status": "passed",
                "findings": [],
                "validations": [],
                "artifacts": [],
                "changed_files": [],
                "limitations": [],
                "requires_refreeze": False,
                "input_fingerprint": "a" * 64,
                "reused": False,
            }
        )
    )
    completed = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_subskill_result.py"), str(result)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert completed.stdout.strip() == "valid"

def test_controller_audit_schema_matches_subskill():
    schema = json.loads((ROOT / "schemas" / "subskill-result.schema.json").read_text())
    disposition = schema["allOf"][0]["then"]["properties"]["data"]["properties"]["controller_disposition"]["enum"]
    assert disposition == ["internally-approved", "remediation-required"]
    assert schema["properties"]["contract_version"]["const"] == "2026-08-06.2"


def test_reused_subskill_result_checks_source_hash(tmp_path):
    import hashlib

    prior = tmp_path / "prior.json"
    prior.write_text(json.dumps({"status": "passed", "evidence": "stable"}))
    fingerprint = "a" * 64
    result = tmp_path / "result.json"
    payload = {
        "schema_version": 1,
        "contract_version": "2026-08-06.2",
        "skill": "design-interface",
        "mode": "internal-verification",
        "status": "passed",
        "findings": [],
        "validations": [],
        "artifacts": [],
        "changed_files": [],
        "limitations": [],
        "requires_refreeze": False,
        "input_fingerprint": fingerprint,
        "reused": True,
        "reuse_source": {
            "result_path": "prior.json",
            "sha256": hashlib.sha256(prior.read_bytes()).hexdigest(),
            "input_fingerprint": fingerprint,
        },
    }
    result.write_text(json.dumps(payload))
    valid = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_subskill_result.py"), str(result)],
        capture_output=True,
        text=True,
    )
    assert valid.returncode == 0, valid.stdout + valid.stderr

    payload["reuse_source"]["sha256"] = "b" * 64
    result.write_text(json.dumps(payload))
    invalid = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_subskill_result.py"), str(result)],
        capture_output=True,
        text=True,
    )
    assert invalid.returncode != 0
    assert "does not match" in invalid.stdout


def test_noop_status_requires_skip_reason_and_contract_mismatch_is_supported(tmp_path):
    result = tmp_path / "result.json"
    payload = {
        "schema_version": 1,
        "contract_version": "2026-08-06.2",
        "skill": "implementar-issue",
        "mode": "implementation",
        "status": "contract-mismatch",
        "findings": [],
        "validations": [],
        "artifacts": [],
        "changed_files": [],
        "limitations": [],
        "requires_refreeze": False,
        "input_fingerprint": "a" * 64,
        "reused": False,
    }
    result.write_text(json.dumps(payload))
    invalid = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_subskill_result.py"), str(result)],
        capture_output=True,
        text=True,
    )
    assert invalid.returncode != 0
    assert "skip_reason" in invalid.stdout

    payload["skip_reason"] = "received contract version is not supported"
    result.write_text(json.dumps(payload))
    valid = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_subskill_result.py"), str(result)],
        capture_output=True,
        text=True,
    )
    assert valid.returncode == 0, valid.stdout + valid.stderr


def test_new_results_must_declare_fingerprint_and_reuse_state(tmp_path):
    result = tmp_path / "result.json"
    payload = {
        "schema_version": 1,
        "contract_version": "2026-08-06.2",
        "skill": "documentacao-repositorio",
        "mode": "orchestrated",
        "status": "passed",
        "findings": [],
        "validations": [],
        "artifacts": [],
        "changed_files": [],
        "limitations": [],
        "requires_refreeze": False,
    }
    result.write_text(json.dumps(payload))
    completed = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_subskill_result.py"), str(result)],
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "input_fingerprint" in completed.stdout
    assert "reused" in completed.stdout
