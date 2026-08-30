import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "host" && mode !== "keychain") {
  process.stderr.write("Usage: node run-tests.mjs <host|keychain>\n");
  process.exit(64);
}
if (process.platform !== "darwin") {
  process.stdout.write(`SKIP macOS mailbox helper ${mode} tests (Darwin only)\n`);
  process.exit(0);
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(directory, mode === "host" ? "test-host.sh" : "test-keychain-integration.sh");
const environment = { ...process.env };
if (mode === "keychain") environment.TRIANGLE_RUN_DISPOSABLE_KEYCHAIN_TEST = "1";
const result = spawnSync("/bin/bash", [script], {
  env: environment,
  stdio: "inherit",
  shell: false,
});
if (result.error) {
  process.stderr.write("Unable to run macOS mailbox helper tests.\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
