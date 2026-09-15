#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../packages/agent-worker/src/app-server-bind-cli.mjs";

void path.dirname(fileURLToPath(import.meta.url));

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: error?.code ?? "error",
    message: error?.message ?? String(error),
  })}\n`);
  process.exit(1);
});
