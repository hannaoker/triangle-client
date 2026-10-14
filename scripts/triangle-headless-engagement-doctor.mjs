#!/usr/bin/env node
import path from "node:path";
import { homedir } from "node:os";

import {
  formatDoctorReport,
  runHeadlessEngagementDoctor,
} from "../packages/agent-worker/src/headless-engagement-doctor.mjs";

const json = process.argv.includes("--json");
const clientRoot = process.env.TRIANGLE_CLIENT_ROOT
  ?? path.join(homedir(), "Library", "Application Support", "The Triangle", "client");

const result = runHeadlessEngagementDoctor({ clientRoot });
if (json) {
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
} else {
  process.stdout.write(formatDoctorReport(result.report));
}
process.exit(result.exitCode);
