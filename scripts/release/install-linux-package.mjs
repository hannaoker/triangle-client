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
  fsyncSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
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
export function safePath(path, { directory = true, privateMode = false } = {}) {
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
    const isDest = candidate === resolve(path);
    if (info.isSymbolicLink()) {
      if (isDest) throw Error(`Unsafe symlink path: ${candidate}`);
      // An ancestor symlink is permitted if it is a system symlink owned by root
      // pointing to a root-owned directory that is not group- or world-writable (e.g. /home -> /var/home).
      let targetStat;
      try { targetStat = statSync(candidate); } catch { throw Error(`Unsafe symlink path: ${candidate}`); }
      if (info.uid !== 0 || targetStat.uid !== 0 || !targetStat.isDirectory() || (targetStat.mode & 0o022) !== 0) {
        throw Error(`Unsafe symlink path: ${candidate}`);
      }
    }
    if (!isDest) {
      if (!info.isDirectory() && !info.isSymbolicLink()) throw Error("Unsafe ancestor");
      if (candidate !== "/tmp" && candidate !== "/private/tmp" && ((info.mode & 0o022) !== 0 || ![0,uid].includes(info.uid))) {
        if (!info.isSymbolicLink()) throw Error("Unsafe ancestor");
      }
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
export function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF", "ENOENT"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function publishJSON(path, value) {
  const temp = path + ".intent-stage-" + process.pid;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); } catch(error) { rmSync(temp,{force:true}); throw error; }
  syncDir(dirname(path));
}

export function runInstaller() {
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
  } else if (process.env.HOME) {
    const envHome = resolve(process.env.HOME);
    let realEnvHome;
    try { realEnvHome = realpathSync(envHome); } catch {}
    if (envHome !== home && realEnvHome !== home)
      throw Error("HOME must be canonical account home");
  }
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
    !((manifest.distribution === "owner-cli" && manifest.serviceSupport === false) || (manifest.distribution === "managed-runtime" && manifest.serviceSupport === true)) || process.platform !== "linux" ||
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
  if (manifest.serviceSupport) for (const required of ["packages/linux-runtime/src/host.mjs", "packages/linux-runtime/src/runner.mjs", "packages/linux-runtime/src/service.mjs", "packages/agent-worker/runners/codex-runner.mjs"]) if (!listed.has(required)) throw Error("Missing managed runtime asset");
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
  const intentPath = join(home, ".triangle-package-install-intent.json");
  const digestPattern = /^[a-f0-9]{64}$/;
  function verifyIntentRelease(intent) {
    safePath(intent.release,{privateMode:true});
    const manifestFile = join(intent.release,"package-manifest.json");
    safePath(manifestFile,{directory:false,privateMode:true});
    if (hash(readFileSync(manifestFile)) !== intent.releaseManifestSHA) throw Error("Interrupted release manifest changed");
    const m = JSON.parse(readFileSync(manifestFile,"utf8"));
    if (m.schema !== 1 || m.version !== intent.version || m.platform !== "linux" || m.arch !== process.arch || !((m.distribution === "owner-cli" && m.serviceSupport === false) || (m.distribution === "managed-runtime" && m.serviceSupport === true)) || m.signingMode !== "none" || m.credentialCustody !== "file" || !Array.isArray(m.files)) throw Error("Invalid interrupted release");
    const expected = new Set(["package-manifest.json"]);
    for (const entry of m.files) {
      if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split("/").some(p=>!p||p==="."||p==="..") || expected.has(entry.path) || ![0o600,0o700].includes(entry.mode) || !digestPattern.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw Error("Invalid interrupted release entry");
      expected.add(entry.path);
      const target = join(intent.release,entry.path);safePath(target,{directory:false});
      if ((lstatSync(target).mode & 0o777) !== entry.mode || lstatSync(target).size !== entry.size || hash(readFileSync(target)) !== entry.sha256) throw Error("Interrupted release integrity mismatch");
    }
    if (m.serviceSupport) for (const required of ["packages/linux-runtime/src/host.mjs", "packages/linux-runtime/src/runner.mjs", "packages/linux-runtime/src/service.mjs", "packages/agent-worker/runners/codex-runner.mjs"]) if (!expected.has(required)) throw Error("Incomplete interrupted managed runtime release");
    for (const required of ["bin/node","packages/triangle-cli/src/cli.mjs","scripts/release/install-linux-package.mjs","LICENSES/node-LICENSE","LICENSES/triangle-LICENSE","packages/triangle-cli/package.json"])if(!expected.has(required))throw Error("Incomplete interrupted release");
    const walk = (dir,prefix="")=>{for(const name of readdirSync(dir)){const relative=prefix+name,target=join(dir,name),info=lstatSync(target);if(info.isDirectory()&&!info.isSymbolicLink())walk(target,relative+"/");else if(!info.isFile()||!expected.has(relative))throw Error("Interrupted release closure mismatch");}};
    walk(intent.release);
  }
  let recoveredOwned = null;
  safePath(intentPath,{directory:false,privateMode:true});
  if (existsSync(intentPath)) {
    if (lstatSync(intentPath).nlink !== 1) throw Error("Unsafe install intent");
    const intent = JSON.parse(readFileSync(intentPath,"utf8"));
    const keys=["schema","wrapper","previousHash","previousReceiptHash","proposedHash","receiptPath","receipt","app","release","version","releaseManifestSHA"].sort();
    if (Object.keys(intent).sort().join() !== keys.join() || intent.schema !== 1 || intent.wrapper !== wrapper || typeof intent.app !== "string" || !intent.app.startsWith("/") || resolve(intent.app)!==intent.app || !intent.app.endsWith("/triangle") || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(intent.version) || intent.release !== join(intent.app,"releases",intent.version) || intent.receiptPath !== join(intent.app,"package-install.json") || !(intent.previousHash===null || digestPattern.test(intent.previousHash)) || !(intent.previousReceiptHash===null || digestPattern.test(intent.previousReceiptHash)) || !digestPattern.test(intent.proposedHash) || !digestPattern.test(intent.releaseManifestSHA)) throw Error("Invalid install intent");
    const receipt=intent.receipt;
    if (!receipt || Object.keys(receipt).sort().join() !== ["schema","distribution","version","release","owned"].sort().join() || receipt.schema!==1 || receipt.distribution!=="owner-cli" || receipt.version!==intent.version || receipt.release!==intent.release || !receipt.owned || Object.keys(receipt.owned).length!==1 || receipt.owned[wrapper]!==intent.proposedHash) throw Error("Invalid intended receipt");
    verifyIntentRelease(intent);
    safePath(intent.receiptPath,{directory:false,privateMode:true});
    const receiptHash=existsSync(intent.receiptPath)?hash(readFileSync(intent.receiptPath)):null;
    if(receiptHash!==intent.previousReceiptHash && receiptHash!==hash(Buffer.from(JSON.stringify(receipt,null,2)+"\n")))throw Error("Interrupted install receipt has unrelated changes");
    safePath(wrapper,{directory:false});
    const actual=existsSync(wrapper)?hash(readFileSync(wrapper)):null;
    if(actual===intent.proposedHash){publishJSON(intent.receiptPath,receipt);recoveredOwned=receipt.owned;}
    else if(actual!==intent.previousHash)throw Error("Interrupted install wrapper has unrelated changes");
    rmSync(intentPath);
    syncDir(dirname(intentPath));
  }
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
    if (prior?.owned[target] !== actual && recoveredOwned?.[target] !== actual)
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
  let releaseCreated = false, releaseStage = null, intentPublished = false;
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
    const owned = {[wrapper]:hash(Buffer.from(wrapperText))};
    const receipt = { schema: 1, distribution: "owner-cli", version: manifest.version, release, owned };
    publishJSON(intentPath,{schema:1,wrapper,previousReceiptHash:existsSync(receiptPath)?hash(readFileSync(receiptPath)):null,previousHash:existsSync(wrapper)?hash(readFileSync(wrapper)):null,proposedHash:owned[wrapper],receiptPath,receipt,app,release,version:manifest.version,releaseManifestSHA:hash(readFileSync(join(release,"package-manifest.json")))});
    intentPublished = true;
    for (const [target, value] of writes) {
      const previous = existsSync(target)
        ? { data: readFileSync(target), mode: lstatSync(target).mode & 0o777 }
        : null;
      const temp = join(
        dirname(target),
        ".triangle-package-" + process.pid + "-" + installed.length,
      );
      const fd = openSync(temp, "wx", value.mode);
      try {
        writeFileSync(fd, value.data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      temporaryFiles.add(temp);
      renameSync(temp, target);
      temporaryFiles.delete(temp);
      syncDir(dirname(target));
      installed.push({ target, previous });
      owned[target] = hash(Buffer.from(value.data));
    }
    publishJSON(receiptPath, receipt);
    rmSync(intentPath);
    syncDir(dirname(intentPath));
    intentPublished = false;
    console.log(
      JSON.stringify({
        state: "installed",
        version: manifest.version,
        release,
        cli: wrapper,
        serviceSupport: manifest.serviceSupport,
        next: `${wrapper} setup`,
      }),
    );
  } catch (error) {
    for (const { target, previous } of installed.reverse()) {
      try {
        if (previous) {
          writeFileSync(target, previous.data, { mode: previous.mode });
          chmodSync(target, previous.mode);
        } else rmSync(target);
      } catch {}
    }
    if (intentPublished) {
      try {
        rmSync(intentPath);
        syncDir(dirname(intentPath));
      } catch {}
    }
    for (const path of temporaryFiles) try { rmSync(path, {force:true}); } catch {}
    if (releaseStage) try { rmSync(releaseStage, {recursive:true,force:true}); } catch {}
    if (releaseCreated) try { rmSync(release, { recursive: true, force: true }); } catch {}
    for (const dir of createdDirectories.reverse()) {
      try { rmdirSync(dir); } catch (cleanupError) { if (!["ENOTEMPTY","ENOENT"].includes(cleanupError.code)) throw cleanupError; }
    }
    throw error;
  }


}
const isDirectExecution = (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) || Boolean(options["verified-stage"]);
if (isDirectExecution) {
  runInstaller();
}
