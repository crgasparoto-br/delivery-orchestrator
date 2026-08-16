import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "compute_stage_fingerprint.py"


def run(out: Path, files: list[Path], values: list[str]) -> dict:
    command = [sys.executable, str(SCRIPT), "--stage", "tests", "--out", str(out)]
    for path in files:
        command += ["--input-file", str(path)]
    for value in values:
        command += ["--value", value]
    subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(out.read_text(encoding="utf-8"))


def test_fingerprint_is_order_independent_and_changes_with_content():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        a, b = root / "a.txt", root / "b.txt"
        a.write_text("alpha", encoding="utf-8")
        b.write_text("beta", encoding="utf-8")
        first = run(root / "one.json", [a, b], ["sha=123", "profile=light"])
        second = run(root / "two.json", [b, a], ["profile=light", "sha=123"])
        assert first["fingerprint"] == second["fingerprint"]
        a.write_text("changed", encoding="utf-8")
        third = run(root / "three.json", [a, b], ["sha=123", "profile=light"])
        assert third["fingerprint"] != first["fingerprint"]
