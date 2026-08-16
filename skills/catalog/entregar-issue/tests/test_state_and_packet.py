from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from orchestrator_gate.packet_validation import validate_packet


class StateAndPacketTests(unittest.TestCase):
    def make_repo(self, root: Path) -> tuple[Path, str]:
        repo = root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
        (repo / "app.py").write_text("x = 1\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
        subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        return repo, head

    def test_sha_change_invalidates_registered_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo, head = self.make_repo(root)
            state = root / "state.json"
            subprocess.run([
                sys.executable, str(ROOT / "scripts/init_orchestration_state.py"),
                "--repository", "owner/repo", "--repo-path", str(repo), "--issue", "1",
                "--base-ref", "main", "--branch", "main", "--out", str(state),
            ], check=True, stdout=subprocess.PIPE, text=True)
            artifact = root / "artifact.txt"
            artifact.write_text("evidence", encoding="utf-8")
            subprocess.run([
                sys.executable, str(ROOT / "scripts/transition_orchestration_state.py"), str(state),
                "--to", "em-correcao", "--reason", "start", "--artifact", f"packet={artifact}",
            ], check=True, stdout=subprocess.PIPE, text=True)
            subprocess.run([
                sys.executable, str(ROOT / "scripts/transition_orchestration_state.py"), str(state),
                "--to", "em-correcao", "--reason", "new commit", "--head-sha", "b" * 40,
            ], check=True, stdout=subprocess.PIPE, text=True)
            data = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual(2, data["cycle"])
            self.assertEqual({}, data["current_artifacts"])
            self.assertEqual(1, len(data["invalidated_artifacts"]))

    def test_packet_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            packet = root / "packet"
            (packet / "production-context").mkdir(parents=True)
            context = packet / "production-context/app.py"
            context.write_text("x=1\n", encoding="utf-8")
            digest = hashlib.sha256(context.read_bytes()).hexdigest()
            (packet / "production_context_files.json").write_text(json.dumps([{"path": "app.py", "sha256": digest}]), encoding="utf-8")
            (packet / "runtime_graph_coverage.json").write_text(json.dumps({"complete": True}), encoding="utf-8")
            metadata = {"schema_version": 3, "head_sha": "a" * 40, "base_ref": "main", "runtime_graph_complete": True}
            (packet / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            files = []
            for rel in ["metadata.json", "production_context_files.json", "runtime_graph_coverage.json", "production-context/app.py"]:
                path = packet / rel
                files.append({"path": rel, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "size": path.stat().st_size})
            manifest = {"schema_version": 3, "files": files}
            (packet / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            evidence = {"packet_path": str(packet), "packet_manifest_sha256": hashlib.sha256((packet / "manifest.json").read_bytes()).hexdigest(), "head_sha": "a" * 40, "base_ref": "main"}
            context.write_text("tampered\n", encoding="utf-8")
            errors = []
            validate_packet(evidence, errors)
            self.assertTrue(any("hash mismatch" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
