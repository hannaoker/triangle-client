#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
      if (!info.isDirectory() || (candidate !== "/tmp" && candidate !== "/private/tmp" && ((info.mode & 0o022) !== 0 || ![0,uid].includes(info.uid)))) throw Error("Unsafe ancestor");
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
if (!options["verified-stage"]) throw Error("--verified-stage is required");
const stage = realpathSync(options["verified-stage"]);
if (stage !== resolve(options["verified-stage"])) throw Error("Unsafe stage symlink");
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
  manifest.signingMode !== "none" ||
  manifest.distribution !== "owner-cli" || manifest.serviceSupport !== false || process.platform !== "linux" ||
  (manifest.testOnly && !testRoot)
)
  throw Error("Invalid verified package");
const listed = new Set(["package-manifest.json"]);
if (!Array.isArray(manifest.files)) throw Error("Invalid manifest files");
for (const entry of manifest.files) {
  if (
    typeof entry.path !== "string" ||
    entry.path.split("/").some((p) => !p || p === "." || p === "..") ||
    entry.path.startsWith("/") ||
    listed.has(entry.path)
  )
    throw Error("Unsafe package manifest path");
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || ![0o600,0o700].includes(entry.mode) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error("Invalid package entry");
  listed.add(entry.path);
  const path = join(stage, entry.path);
  safePath(path, { directory: false });
  if ((lstatSync(path).mode & 0o777) !== entry.mode) throw Error("Package mode mismatch");
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
for (const required of ["bin/node","packages/triangle-cli/src/cli.mjs","scripts/release/install-linux-package.mjs","LICENSES/node-LICENSE","LICENSES/triangle-LICENSE","packages/triangle-cli/package.json"]) if (!listed.has(required)) throw Error("Missing required package asset");
const dataHome = testRoot ? join(home, ".local/share") : (process.env.XDG_DATA_HOME || join(home, ".local/share"));
if (!dataHome.startsWith("/") || resolve(dataHome) !== dataHome) throw Error("XDG_DATA_HOME must be a safe absolute path");
const app = join(dataHome, "triangle"), releases = join(app,"releases"), release = join(releases,manifest.version), receiptPath = join(app,"package-install.json"), wrapper = join(home,".local/bin/triangle");
const directories = [...new Set([dataHome, app, releases, join(home,".local"), join(home,".local/bin")])];
for (const dir of directories) safePath(dir);
safePath(receiptPath,{directory:false,privateMode:true});
// One kernel-held SQLite writer lock serializes receipt checks, publication and
// rollback across all XDG data locations that share this account's CLI wrapper.
const lockPath = join(home, ".triangle-package-install.sqlite");
safePath(lockPath, {directory:false,privateMode:true});
try { closeSync(openSync(lockPath, "wx", 0o600)); } catch(error) { if(error.code !== "EEXIST") throw error; }
safePath(lockPath, {directory:false,privateMode:true});
if (lstatSync(lockPath).nlink !== 1) throw Error("Unsafe install transaction lock");
const transaction = new DatabaseSync(lockPath);
transaction.exec("PRAGMA busy_timeout=30000; BEGIN IMMEDIATE;");
process.once("exit",()=>{ transaction.close(); });
let prior = null;
if (existsSync(receiptPath)) {
 prior=JSON.parse(readFileSync(receiptPath,"utf8"));
 if(prior.schema!==1 || prior.distribution!=="owner-cli" || !prior.owned || Object.keys(prior.owned).some(p=>p!==wrapper)) throw Error("Invalid package ownership receipt");
}
const wrapperTarget = wrapper;
safePath(wrapper, {directory:false});
const wrapperText = `#!/bin/sh\n# Triangle packaged CLI; managed by package-install.json\nexport PATH=${shellQuote(join(release, "bin"))}:"$PATH"\nexec ${shellQuote(join(release, "bin/node"))} ${shellQuote(join(release, "packages/triangle-cli/src/cli.mjs"))} "$@"\n`;
function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
const writes = new Map([[wrapperTarget, { data: wrapperText, mode: 0o700 }]]);
// Inspect every collision before changing any application destination. A package
// receipt only authorizes files whose current hash still matches that receipt.
for (const [target, value] of writes) {
  safePath(target, { directory: false });
  if (!existsSync(target)) continue;
  const actual = hash(readFileSync(target));
  if (prior?.owned[target] !== actual)
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
    if ((lstatSync(target).mode & 0o777) !== entry.mode || hash(readFileSync(target)) !== entry.sha256)
      throw Error("Existing release failed integrity verification");
  }
}
const installed = [], createdDirectories = [], temporaryFiles = new Set();
let releaseCreated = false, releaseStage = null;
function createDirectory(path) {
  if (existsSync(path)) return;
  createDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  createdDirectories.push(path);
}
try {
  for (const dir of directories) createDirectory(dir);
  if (!existsSync(release)) {
    releaseStage = mkdtempSync(join(releases, "." + manifest.version + "-stage-"));
    for (const entry of [
      { path: "package-manifest.json", mode: 0o600 },
      ...manifest.files,
    ]) {
      const target = join(releaseStage, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(stage, entry.path), target);
      chmodSync(target, entry.mode);
    }
    renameSync(releaseStage, release);
    releaseStage = null;
    releaseCreated = true;
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
    temporaryFiles.add(temp);
    renameSync(temp, target);
    temporaryFiles.delete(temp);
    installed.push({ target, previous });
    owned[target] = hash(Buffer.from(value.data));
  }
  const receipt = { schema: 1, distribution: "owner-cli", version: manifest.version, release, owned };
  const tmp = receiptPath + ".stage-" + process.pid;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  temporaryFiles.add(tmp);
  renameSync(tmp, receiptPath);
  temporaryFiles.delete(tmp);
  console.log(
    JSON.stringify({
      state: "installed",
      version: manifest.version,
      release,
      cli: wrapper,
      serviceSupport: false,
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
  for (const path of temporaryFiles) rmSync(path, {force:true});
  if (releaseStage) rmSync(releaseStage, {recursive:true,force:true});
  if (releaseCreated) rmSync(release, { recursive: true, force: true });
  for (const dir of createdDirectories.reverse()) {
    try { rmdirSync(dir); } catch (cleanupError) { if (!["ENOTEMPTY","ENOENT"].includes(cleanupError.code)) throw cleanupError; }
  }
  throw error;
}
