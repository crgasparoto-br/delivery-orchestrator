#!/usr/bin/env bash
set -u

usage() {
  cat <<'USAGE'
Usage: run_ecosystem_tests.sh --skills-root DIR [--profile fast|full] [--skill NAME ...] [--report FILE] [--fail-fast]

Runs every selected pytest module in a fresh Python process. The default fast
profile covers architecture, contracts, planning, state and audit boundaries.
The full profile runs every test module and is intended for freeze/package time.
USAGE
}

skills_root=""
report=""
profile="fast"
fail_fast=0
skills=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skills-root)
      skills_root=${2:-}; shift 2 ;;
    --profile)
      profile=${2:-}; shift 2 ;;
    --skill)
      skills+=("${2:-}"); shift 2 ;;
    --report)
      report=${2:-}; shift 2 ;;
    --fail-fast)
      fail_fast=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$skills_root" ]; then
  echo "--skills-root is required" >&2
  exit 2
fi
case "$profile" in
  fast|full) ;;
  *) echo "--profile must be fast or full" >&2; exit 2 ;;
esac
skills_root=$(cd "$skills_root" 2>/dev/null && pwd) || {
  echo "skills root not found: $skills_root" >&2
  exit 2
}
if [ "${#skills[@]}" -eq 0 ]; then
  skills=(
    entregar-issue auditar-issue revisar-issue documentacao-repositorio
    design-interface fluxos-conversacionais
  )
fi

python_bin=${PYTHON:-python}
timeout_seconds=${TEST_FILE_TIMEOUT_SECONDS:-60}
results_file=$(mktemp)
trap 'rm -f "$results_file"' EXIT HUP INT TERM
passed=0
failed=0
started=$(date +%s)

fast_tests() {
  case "$1" in
    entregar-issue)
      cat <<'LIST'
tests/test_composition_contract.py
tests/test_controller_context.py
tests/test_deterministic_planning.py
tests/test_ecosystem_contracts.py
tests/test_internal_delegation_ownership.py
tests/test_single_invocation_controller.py
tests/test_state_and_packet.py
tests/test_throughput_quality_contract.py
LIST
      ;;
    auditar-issue)
      cat <<'LIST'
tests/test_controller_mode_contract.py
tests/test_input_parser_audit_contract.py
tests/test_report_order_contract.py
LIST
      ;;
    revisar-issue|documentacao-repositorio|fluxos-conversacionais)
      echo tests/test_delivery_contract.py
      ;;
    design-interface)
      echo tests/test_contract_sync.py
      ;;
  esac
}

for skill in "${skills[@]}"; do
  skill_dir="$skills_root/$skill"
  if [ ! -d "$skill_dir" ]; then
    printf 'failed\t%s\t%s\t0\t%s\n' "$skill" "" "skill directory not found" >> "$results_file"
    echo "[FAIL] $skill: directory not found"
    failed=$((failed + 1))
    [ "$fail_fast" -eq 1 ] && break
    continue
  fi

  if [ "$profile" = fast ]; then
    mapfile -t selected < <(fast_tests "$skill")
  else
    mapfile -t selected < <(find "$skill_dir/tests" -maxdepth 1 -type f -name 'test_*.py' -printf 'tests/%f\n' 2>/dev/null | sort)
  fi

  if [ "${#selected[@]}" -eq 0 ]; then
    echo "[SKIP] $skill: no tests in $profile profile"
    continue
  fi

  for relative in "${selected[@]}"; do
    test_file="$skill_dir/$relative"
    if [ ! -f "$test_file" ]; then
      printf 'failed\t%s\t%s\t0\t%s\n' "$skill" "$relative" "test file not found" >> "$results_file"
      echo "[FAIL] $skill/$relative: file not found"
      failed=$((failed + 1))
      [ "$fail_fast" -eq 1 ] && break 2
      continue
    fi
    output_file=$(mktemp)
    test_started=$(date +%s)
    if (
      cd "$skill_dir" &&
      PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
      PYTHONPATH="$skill_dir/scripts${PYTHONPATH:+:$PYTHONPATH}" \
      timeout "${timeout_seconds}s" "$python_bin" -m pytest -q "$relative"
    ) >"$output_file" 2>&1; then
      status=passed
      passed=$((passed + 1))
      marker=PASS
    else
      status=failed
      failed=$((failed + 1))
      marker=FAIL
    fi
    test_finished=$(date +%s)
    elapsed=$((test_finished - test_started))
    summary=$(tail -n 1 "$output_file" | tr '\t\r\n' '   ')
    printf '%s\t%s\t%s\t%s\t%s\n' "$status" "$skill" "$relative" "$elapsed" "$summary" >> "$results_file"
    echo "[$marker] $skill/$relative (${elapsed}s)"
    if [ "$status" = failed ]; then
      cat "$output_file"
    fi
    rm -f "$output_file"
    if [ "$status" = failed ] && [ "$fail_fast" -eq 1 ]; then
      break 2
    fi
  done
done

finished=$(date +%s)
elapsed=$((finished - started))
if [ -n "$report" ]; then
  mkdir -p "$(dirname "$report")"
  "$python_bin" - "$results_file" "$report" "$skills_root" "$elapsed" "$profile" <<'PY'
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

source, target, root, elapsed, profile = sys.argv[1:]
results = []
with open(source, encoding="utf-8", newline="") as handle:
    for status, skill, test_file, seconds, summary in csv.reader(handle, delimiter="\t"):
        results.append({
            "status": status,
            "skill": skill,
            "test_file": test_file or None,
            "elapsed_seconds": int(seconds),
            "summary": summary,
        })
payload = {
    "schema_version": 2,
    "profile": profile,
    "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "skills_root": root,
    "elapsed_seconds": int(elapsed),
    "test_files": len(results),
    "passed": sum(item["status"] == "passed" for item in results),
    "failed": sum(item["status"] == "failed" for item in results),
    "results": results,
}
path = Path(target).resolve()
path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"report={path}")
PY
fi

echo "summary: profile=$profile passed=$passed failed=$failed files=$((passed + failed)) elapsed=${elapsed}s"
[ "$failed" -eq 0 ]
