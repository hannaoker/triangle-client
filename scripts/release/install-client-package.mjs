#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--verified-stage", "--test-root"].includes(args[i]) || !args[i + 1])
    throw Error("Invalid installer arguments");
  options[args[i].slice(2)] = args[i + 1];
}
const hash = (data) => createHash("sha256").update(data).digest("hex");
const uid = process.getuid();
function safePath(path, { directory = true, privateMode = false } = {}) {
  let current = resolve(path);
  const chain = [];
  while (current !== dirname(current)) {
    chain.unshift(current);
    current = dirname(current);
  }
  for (const candidate of chain) {
    let info;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || realpathSync(candidate) !== candidate)
      throw Error(`Unsafe symlink path: ${candidate}`);
    if (candidate !== resolve(path)) {
      if (!info.isDirectory()) throw Error("Unsafe ancestor");
      continue;
    }
    if (
      (directory ? !info.isDirectory() : !info.isFile()) ||
      info.uid !== uid ||
      (info.mode & 0o022) !== 0 ||
      (privateMode && (info.mode & 0o777) !== (directory ? 0o700 : 0o600))
    )
      throw Error(`Unsafe install destination: ${candidate}`);
  }
}
let home = realpathSync(userInfo().homedir);
const testRoot = options["test-root"];
if (testRoot) {
  const root = realpathSync(testRoot);
  if (
    root !== resolve(testRoot) ||
    !root.startsWith(realpathSync(tmpdir()) + "/triangle-package-install-") ||
    dirname(root) !== realpathSync(tmpdir())
  )
    throw Error("Unsafe test root");
  safePath(root, { privateMode: true });
  home = join(root, "home");
  safePath(home, { privateMode: true });
} else if (process.env.HOME && resolve(process.env.HOME) !== home)
  throw Error("HOME must be canonical account home");
const stage = realpathSync(options["verified-stage"] ?? "");
safePath(stage, { privateMode: true });
const manifest = JSON.parse(
  readFileSync(join(stage, "package-manifest.json"), "utf8"),
);
if (
  manifest.schema !== 1 ||
  manifest.platform !== process.platform ||
  manifest.arch !== process.arch ||
  !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) ||
  manifest.credentialCustody !== "file" ||
  manifest.signingMode !== "public_ad_hoc" ||
  (manifest.testOnly && !testRoot)
)
  throw Error("Invalid verified package");
const listed = new Set(["package-manifest.json"]);
for (const entry of manifest.files) {
  if (
    typeof entry.path !== "string" ||
    entry.path.split("/").some((p) => !p || p === "." || p === "..") ||
    entry.path.startsWith("/") ||
    listed.has(entry.path)
  )
    throw Error("Unsafe package manifest path");
  listed.add(entry.path);
  const path = join(stage, entry.path);
  safePath(path, { directory: false });
  const data = readFileSync(path);
  if (data.length !== entry.size || hash(data) !== entry.sha256)
    throw Error("Package integrity mismatch");
}
function checkClosure(dir, prefix = "") {
  for (const name of readdirSync(dir)) {
    const relative = prefix + name,
      path = join(dir, name),
      info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink())
      checkClosure(path, relative + "/");
    else if (!info.isFile() || !listed.has(relative))
      throw Error("Unmanifested package file");
  }
}
checkClosure(stage);
const app = join(home, "Library/Application Support/The Triangle"),
  releases = join(app, "releases"),
  release = join(releases, manifest.version),
  receiptPath = join(app, "package-install.json"),
  wrapper = join(home, ".local/bin/triangle");
const directories = [
  join(home, "Library"),
  join(home, "Library/Application Support"),
  app,
  releases,
  join(app, "bin"),
  join(app, "install-manifest"),
  join(app, "credentials"),
  join(app, "credentials/local"),
  join(app, "worker-runtime"),
  join(app, "model-state"),
  join(app, "client"),
  join(home, ".local"),
  join(home, ".local/bin"),
  join(home, "Library/LaunchAgents"),
  join(home, "Library/Logs"),
  join(home, "Library/Logs/the-triangle"),
];
for (const dir of directories)
  safePath(dir, {
    privateMode: [
      app,
      releases,
      join(app, "bin"),
      join(app, "install-manifest"),
      join(app, "credentials"),
      join(app, "credentials/local"),
      join(app, "worker-runtime"),
      join(app, "model-state"),
      join(app, "client"),
    ].includes(dir),
  });
safePath(receiptPath, { directory: false, privateMode: true });
let prior = null;
if (existsSync(receiptPath)) {
  safePath(receiptPath, { directory: false, privateMode: true });
  prior = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (prior.schema !== 1 || typeof prior.owned !== "object")
    throw Error("Invalid package ownership receipt");
}
const legacyOwned = {};
if (
  !prior &&
  ["triangle-mailbox", "triangle-client"].some((name) =>
    existsSync(join(app, "bin", name)),
  )
) {
  for (const name of ["triangle-mailbox", "triangle-client"]) {
    const binary = join(app, "bin", name),
      hashFile = join(app, "install-manifest", name + ".sha256"),
      metadataFile = join(app, "install-manifest", name + "-install.json");
    for (const path of [binary, hashFile, metadataFile]) {
      safePath(path, { directory: false });
      if (!existsSync(path))
        throw Error(
          "Incomplete legacy install; preserve and repair it before upgrading",
        );
    }
    if (
      (lstatSync(binary).mode & 0o777) !== 0o700 ||
      (lstatSync(hashFile).mode & 0o777) !== 0o600 ||
      (lstatSync(metadataFile).mode & 0o777) !== 0o600
    )
      throw Error("Legacy install permissions are unsafe");
    const digest = hash(readFileSync(binary)),
      metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    if (
      metadata.version !== 1 ||
      metadata.signingMode !== "public_ad_hoc" ||
      metadata.credentialCustody !== "file" ||
      metadata.sha256 !== digest ||
      readFileSync(hashFile, "utf8").trim() !== digest
    )
      throw Error("Legacy public/file binary verification failed");
    for (const path of [binary, hashFile, metadataFile])
      legacyOwned[path] = hash(readFileSync(path));
  }
}
let wrapperTarget = wrapper;
let wrapperInfo;
try {
  wrapperInfo = lstatSync(wrapper);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (wrapperInfo?.isSymbolicLink()) {
  safePath(dirname(wrapper));
  const expectedTarget = join(app, "bin/triangle");
  if (wrapperInfo.uid !== uid || realpathSync(wrapper) !== expectedTarget)
    throw Error("Unrecognized triangle CLI symlink");
  wrapperTarget = expectedTarget;
}
if (existsSync(wrapperTarget) && !prior?.owned[wrapperTarget]) {
  safePath(wrapperTarget, { directory: false });
  const legacyText = `#!/bin/bash\nexec ${home}/.hermes/node/bin/node "${app}/owner-cli/src/cli.mjs" "$@"\n`;
  if (
    !Object.keys(legacyOwned).length ||
    readFileSync(wrapperTarget, "utf8") !== legacyText
  )
    throw Error(
      "Existing triangle CLI wrapper is not the verified legacy wrapper",
    );
  legacyOwned[wrapperTarget] = hash(readFileSync(wrapperTarget));
}
const wrapperText = `#!/bin/sh\n# Triangle packaged CLI; managed by package-install.json\nexport PATH=${shellQuote(join(release, "bin"))}:"$PATH"\nexec ${shellQuote(join(release, "bin/node"))} ${shellQuote(join(release, "packages/triangle-cli/src/cli.mjs"))} "$@"\n`;
function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
const writes = new Map([[wrapperTarget, { data: wrapperText, mode: 0o700 }]]);
for (const binary of ["triangle-mailbox", "triangle-client"]) {
  const data = readFileSync(join(stage, "bin", binary)),
    digest = hash(data),
    now = new Date().toISOString();
  writes.set(join(app, "bin", binary), { data, mode: 0o700 });
  writes.set(join(app, "install-manifest", binary + ".sha256"), {
    data: digest + "\n",
    mode: 0o600,
  });
  writes.set(join(app, "install-manifest", binary + "-install.json"), {
    data:
      JSON.stringify({
        version: 1,
        identifier:
          binary === "triangle-mailbox"
            ? "dev.thetriangle.mailbox"
            : "dev.thetriangle.client",
        signingMode: "public_ad_hoc",
        teamId: null,
        credentialCustody: "file",
        sha256: digest,
        installedAt: now,
        verifiedAt: now,
      }) + "\n",
    mode: 0o600,
  });
}
const marker = join(app, "credentials/local/ENABLED");
if (existsSync(marker)) safePath(marker, { directory: false });
else writes.set(marker, { data: "file\n", mode: 0o600 });
const plist = join(home, "Library/LaunchAgents/dev.thetriangle.client.plist");
const serviceAlreadyConfigured = existsSync(plist);
if (!existsSync(plist)) {
  const escape = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const template = readFileSync(
    join(stage, "deploy/launchd/dev.thetriangle.client.plist.template"),
    "utf8",
  );
  writes.set(plist, {
    data: template
      .replaceAll("__HELPER__", escape(join(app, "bin/triangle-mailbox")))
      .replaceAll(
        "__LOG_DIR__",
        escape(join(home, "Library/Logs/the-triangle")),
      ),
    mode: 0o600,
  });
} else safePath(plist, { directory: false, privateMode: true });
// Inspect every collision before changing any application destination. A package
// receipt only authorizes files whose current hash still matches that receipt.
for (const [target, value] of writes) {
  safePath(target, { directory: false });
  if (!existsSync(target)) continue;
  const actual = hash(readFileSync(target));
  if (prior?.owned[target] !== actual && legacyOwned[target] !== actual)
    throw Error(
      `Existing file is not an unchanged package-owned file: ${target}`,
    );
}
if (existsSync(release)) {
  safePath(release, { privateMode: true });
  checkClosure(release);
  const old = readFileSync(join(release, "package-manifest.json"));
  if (hash(old) !== hash(readFileSync(join(stage, "package-manifest.json"))))
    throw Error("Version already installed with different contents");
  for (const entry of manifest.files) {
    const target = join(release, entry.path);
    safePath(target, { directory: false });
    if (hash(readFileSync(target)) !== entry.sha256)
      throw Error("Existing release failed integrity verification");
  }
}
for (const dir of directories) {
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
}
const installed = [];
let releaseCreated = false;
try {
  if (!existsSync(release)) {
    mkdirSync(release, { mode: 0o700 });
    releaseCreated = true;
    for (const entry of [
      { path: "package-manifest.json", mode: 0o600 },
      ...manifest.files,
    ]) {
      const target = join(release, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(stage, entry.path), target);
      chmodSync(target, entry.mode);
    }
  }
  const owned = { ...(prior?.owned ?? {}) };
  for (const [target, value] of writes) {
    const previous = existsSync(target)
      ? { data: readFileSync(target), mode: lstatSync(target).mode & 0o777 }
      : null;
    const temp = join(
      dirname(target),
      ".triangle-package-" + process.pid + "-" + installed.length,
    );
    writeFileSync(temp, value.data, { mode: value.mode, flag: "wx" });
    renameSync(temp, target);
    installed.push({ target, previous });
    owned[target] = hash(Buffer.from(value.data));
  }
  const receipt = { schema: 1, version: manifest.version, release, owned };
  const tmp = receiptPath + ".stage-" + process.pid;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(tmp, receiptPath);
  console.log(
    JSON.stringify({
      state: "installed",
      version: manifest.version,
      release,
      cli: wrapper,
      service: serviceAlreadyConfigured
        ? "existing service unchanged"
        : "staged; stopped",
      next: `${wrapper} setup`,
    }),
  );
} catch (error) {
  for (const { target, previous } of installed.reverse()) {
    if (previous) {
      writeFileSync(target, previous.data, { mode: previous.mode });
      chmodSync(target, previous.mode);
    } else rmSync(target);
  }
  if (releaseCreated) rmSync(release, { recursive: true, force: true });
  throw error;
}
