from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_attested_gate.py"


class RunAttestedGateTests(unittest.TestCase):
    def test_records_stdout_stderr_and_exit_code(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            out = root / "out"
            result = subprocess.run([
                sys.executable, str(SCRIPT),
                "--name", "sample",
                "--head-sha", "1" * 40,
                "--cwd", str(root),
                "--out-dir", str(out),
                "--command", "printf 'ok\\n'; printf 'warn\\n' >&2",
                "--allow-non-git",
            ], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            attestation = json.loads((out / "attestation.json").read_text())
            self.assertEqual(attestation["exit_code"], 0)
            self.assertEqual(attestation["stdout_sha256"], hashlib.sha256(b"ok\n").hexdigest())
            self.assertEqual(attestation["stderr_sha256"], hashlib.sha256(b"warn\n").hexdigest())
            self.assertEqual(payload["attestation_sha256"], hashlib.sha256((out / "attestation.json").read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
