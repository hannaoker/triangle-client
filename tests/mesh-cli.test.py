"""CLI wiring tests. The fake helper never accesses real accounts or the network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "scripts/mesh"


class MeshCLITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="triangle-mesh-cli-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.helper = self.root / "triangle-mailbox"
        self.helper.write_text(
            "#!" + sys.executable + "\n"
            "import json,os,sys\n"
            "print(json.dumps({'home':os.environ.get('TRIANGLE_HOME'),'args':sys.argv[1:]}))\n"
            "sys.exit(int(os.environ.get('FIXTURE_EXIT','0')))\n"
        )
        self.helper.chmod(0o700)
        self.env = dict(os.environ)
        for key in ("TRIANGLE_HOME", "TRIANGLE_MAILBOX_BIN", "MESH_PROFILE"):
            self.env.pop(key, None)
        self.env["PATH"] = str(self.root)

    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, str(CLI), *arguments], env=self.env,
                              text=True, capture_output=True, timeout=10)

    def test_path_helper_and_home_forwarding(self):
        self.env["TRIANGLE_HOME"] = str(self.root / "environment")
        result = self.run_cli("--home", str(self.root / "selected home"), "paths")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "home": str(self.root / "selected home"), "args": ["paths"]})

    def test_status_propagates_profile_and_failure(self):
        self.env["FIXTURE_EXIT"] = "7"
        result = self.run_cli("--profile", "test-agent", "status")
        self.assertEqual(result.returncode, 7)
        self.assertEqual(json.loads(result.stdout)["args"], ["status", "--profile", "test-agent"])

    def test_explicit_binary_precedes_path(self):
        self.env["TRIANGLE_MAILBOX_BIN"] = str(self.root / "missing-helper")
        result = self.run_cli("paths")
        self.assertEqual(result.returncode, 127)
        self.assertIn("unavailable", result.stderr)

    def test_relative_home_is_rejected(self):
        result = self.run_cli("--home", "relative", "paths")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
