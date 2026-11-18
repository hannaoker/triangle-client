// A release directory that the packaged owner-approval loader accepts and whose "binary" only records that it was started.
// A test that must not reach the OS prompt looks at `started()`: when the loader refuses a capability the binary is never run, and when it
// accepts one the binary is, which is what tells the capability names apart.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function markerRelease(commands) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owner-release-")));
  fs.chmodSync(root, 0o700);
  const release = path.join(root, "release");
  const marker = path.join(root, "started");
  const executable = path.join(release, "bin/triangle-owner-approval");
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  fs.chmodSync(release, 0o700);
  fs.writeFileSync(executable, `#!/bin/sh\n: > '${marker}'\nexit 0\n`, { mode: 0o700 });
  const manifest = {
    schema: 1,
    platform: "darwin",
    arch: process.arch,
    testOnly: false,
    signingMode: "public_ad_hoc",
    credentialCustody: "file",
    ownerApproval: { version: 1, binary: "bin/triangle-owner-approval", commands },
    files: [{ path: "bin/triangle-owner-approval", mode: 0o700, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") }],
  };
  fs.writeFileSync(path.join(release, "package-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return {
    release,
    started: () => fs.existsSync(marker),
    reset: () => fs.rmSync(marker, { force: true }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
