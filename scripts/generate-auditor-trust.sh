#!/usr/bin/env bash
set -euo pipefail
OUT=${1:-./auditor-trust}
KEY_ID=${2:-delivery-independent-auditor-v1}
REPOSITORY_PATTERN=${3:-'*'}
NAME=${AUDITOR_NAME:-Independent Delivery Auditor}
mkdir -p "$OUT"
CATALOG=${SKILL_CATALOG:-$(cd "$(dirname "$0")/../skills/catalog" && pwd)}
python3 "$CATALOG/auditar-issue/scripts/generate_auditor_keypair.py" \
  --private-out "$OUT/auditor-private.pem" \
  --public-out "$OUT/auditor-public.pem" \
  --password-env AUDITOR_KEY_PASSWORD
printf '%s\n' "$KEY_ID" > "$OUT/key-id.txt"
base64 < "$OUT/auditor-private.pem" | tr -d '\n' > "$OUT/auditor-private.pem.b64"
python3 - "$OUT/auditor-public.pem" "$OUT/trusted-auditors.json" "$KEY_ID" "$NAME" "$REPOSITORY_PATTERN" <<'PY'
import hashlib
import json
import sys
from pathlib import Path
public_path, registry_path, key_id, name, repository_pattern = sys.argv[1:]
pem = Path(public_path).read_text(encoding='utf-8')
registry = {
    'schema_version': 1,
    'auditors': [{
        'key_id': key_id,
        'name': name,
        'enabled': True,
        'repositories': [repository_pattern],
        'public_key_pem': pem,
        'public_key_sha256': hashlib.sha256(pem.encode('utf-8')).hexdigest(),
    }],
}
Path(registry_path).write_text(json.dumps(registry, indent=2) + '\n', encoding='utf-8')
PY
python3 - "$OUT/trusted-auditors.json" "$CATALOG/auditar-issue/schemas/trusted-auditors.schema.json" <<'PY'
import json
import sys
from jsonschema import Draft202012Validator
registry_path, schema_path = sys.argv[1:]
registry = json.load(open(registry_path, encoding='utf-8'))
schema = json.load(open(schema_path, encoding='utf-8'))
errors = sorted(Draft202012Validator(schema).iter_errors(registry), key=lambda e: list(e.path))
if errors:
    for error in errors:
        print(error.message, file=sys.stderr)
    raise SystemExit(2)
PY
echo "Generated auditor trust material for ${REPOSITORY_PATTERN}."
echo "SECRET: $OUT/auditor-private.pem and $OUT/auditor-private.pem.b64"
echo "PUBLIC: $OUT/auditor-public.pem, $OUT/key-id.txt, $OUT/trusted-auditors.json"
