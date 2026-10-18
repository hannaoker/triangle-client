import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "host") {
  process.stderr.write("Usage: node run-tests.mjs host\n");
  process.exit(64);
}
if (process.platform !== "darwin") {
  process.stdout.write(`SKIP macOS mailbox helper ${mode} tests (Darwin only)\n`);
  process.exit(0);
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(directory, "test-host.sh");
const environment = { ...process.env };
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
