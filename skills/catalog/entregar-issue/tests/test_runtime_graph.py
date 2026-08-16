from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from runtime_graph import build_runtime_context


class RuntimeGraphTests(unittest.TestCase):
    def test_typescript_alias_and_reverse_caller(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src/services").mkdir(parents=True)
            (repo / "src/lib").mkdir(parents=True)
            (repo / "src/pages").mkdir(parents=True)
            (repo / "tsconfig.json").write_text('{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', encoding="utf-8")
            (repo / "src/services/order.ts").write_text('import { save } from "@/lib/store"; export const run = save;', encoding="utf-8")
            (repo / "src/lib/store.ts").write_text('export const save = () => true;', encoding="utf-8")
            (repo / "src/pages/api.ts").write_text('import { run } from "@/services/order"; export default run;', encoding="utf-8")
            files, edges, unresolved, coverage = build_runtime_context(repo, ["src/services/order.ts"])
            paths = {item["path"] for item in files}
            self.assertIn("src/lib/store.ts", paths)
            self.assertIn("src/pages/api.ts", paths)
            self.assertFalse(unresolved)
            self.assertTrue(coverage["complete"])
            self.assertGreaterEqual(coverage["reverse_callers"], 1)

    def test_typescript_base_url_import(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src/services").mkdir(parents=True)
            (repo / "src/lib").mkdir(parents=True)
            (repo / "tsconfig.json").write_text('{"compilerOptions":{"baseUrl":"."}}', encoding="utf-8")
            (repo / "src/services/order.ts").write_text('import { save } from "src/lib/store"; export const run = save;', encoding="utf-8")
            (repo / "src/lib/store.ts").write_text('export const save = () => true;', encoding="utf-8")
            files, _, unresolved, coverage = build_runtime_context(repo, ["src/services/order.ts"])
            self.assertIn("src/lib/store.ts", {item["path"] for item in files})
            self.assertFalse(unresolved)
            self.assertTrue(coverage["complete"])

    def test_deleted_module_uses_base_snapshot_and_finds_callers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src/caller.ts").write_text('import { removed } from "./deleted"; export const value = removed;', encoding="utf-8")
            files, edges, unresolved, coverage = build_runtime_context(
                repo, ["src/deleted.ts"], {"src/deleted.ts": "export const removed = 1;"}
            )
            paths = {item["path"] for item in files}
            self.assertIn("src/deleted.ts", paths)
            self.assertIn("src/caller.ts", paths)
            self.assertFalse(unresolved)
            self.assertTrue(coverage["complete"])
            self.assertTrue(any(edge["direction"] == "caller" for edge in edges))

    def test_python_absolute_local_import(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "app/services").mkdir(parents=True)
            (repo / "app/repositories").mkdir(parents=True)
            (repo / "app/services/task.py").write_text('from app.repositories.store import save\ndef run(): return save()\n', encoding="utf-8")
            (repo / "app/repositories/store.py").write_text('def save(): return True\n', encoding="utf-8")
            files, _, unresolved, coverage = build_runtime_context(repo, ["app/services/task.py"])
            self.assertIn("app/repositories/store.py", {item["path"] for item in files})
            self.assertFalse(unresolved)
            self.assertTrue(coverage["complete"])


    def test_malformed_package_manifest_fails_runtime_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "package.json").write_text('{ invalid', encoding="utf-8")
            (repo / "src/main.ts").write_text('export const value = 1;', encoding="utf-8")
            _, _, _, coverage = build_runtime_context(repo, ["src/main.ts"])
            self.assertFalse(coverage["complete"])
            self.assertTrue(any("package manifest" in item for item in coverage["configuration_errors"]))

    def test_dynamic_bundler_alias_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "vite.config.ts").write_text(
                'const aliases = loadAliases(); export default { resolve: { alias: aliases } };',
                encoding="utf-8",
            )
            (repo / "src/main.ts").write_text('import value from "@/value";', encoding="utf-8")
            _, _, unresolved, coverage = build_runtime_context(repo, ["src/main.ts"])
            self.assertFalse(coverage["complete"])
            self.assertTrue(unresolved)
            self.assertTrue(any("cannot statically resolve aliases" in item for item in coverage["configuration_errors"]))

    def test_python_syntax_error_is_not_treated_as_complete_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "app").mkdir()
            (repo / "app/main.py").write_text('def broken(:\n    pass\n', encoding="utf-8")
            _, _, unresolved, coverage = build_runtime_context(repo, ["app/main.py"])
            self.assertFalse(coverage["complete"])
            self.assertTrue(any(item.get("reason") == "source-parse-error" for item in unresolved))

    def test_malformed_dotnet_project_is_not_treated_as_complete_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "App").mkdir()
            (repo / "App/App.csproj").write_text('<Project><ItemGroup>', encoding="utf-8")
            (repo / "App/Program.cs").write_text('namespace App; public class Program {}', encoding="utf-8")
            _, _, unresolved, coverage = build_runtime_context(repo, ["App/Program.cs"])
            self.assertFalse(coverage["complete"])
            self.assertTrue(any(item.get("reason") == "project-configuration-error" for item in unresolved))


if __name__ == "__main__":
    unittest.main()
