#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (
    ![
      "--version",
      "--helper",
      "--client",
      "--node",
      "--output",
      "--test-root",
      "--helper-metadata",
      "--client-metadata",
      "--node-license",
    ].includes(args[i]) ||
    !args[i + 1]
  )
    throw Error(
      "Usage: build-client-package.mjs --version VERSION --output DIR [--helper FILE --client FILE] [--node FILE]",
    );
  options[args[i].slice(2)] = args[i + 1];
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(options.version ?? ""))
  throw Error("An explicit safe release version is required");
if (process.platform !== "darwin")
  throw Error("Only macOS packages are supported");
if (!options.output) throw Error("--output is required");
const scratch = mkdtempSync(join(tmpdir(), "triangle-package-build-"));
const digest = (data) => createHash("sha256").update(data).digest("hex");
try {
  const stage = join(scratch, "payload");
  mkdirSync(stage, { mode: 0o700 });
  let helper = options.helper,
    client = options.client;
  const prebuilt = Boolean(helper);
  if (Boolean(helper) !== Boolean(client))
    throw Error("Provide both --helper and --client");
  if (!helper) {
    const build = join(scratch, "swift");
    for (const product of ["triangle-mailbox", "triangle-client"])
      execFileSync(
        "/usr/bin/swift",
        [
          "build",
          "--disable-sandbox",
          "-c",
          "release",
          "--package-path",
          join(root, "packages/macos-mailbox-helper"),
          "--scratch-path",
          build,
          "-Xswiftc",
          "-DTRIANGLE_FILE_CUSTODY_REQUIRED",
          "--product",
          product,
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            CLANG_MODULE_CACHE_PATH: join(build, "module-cache"),
            SWIFTPM_MODULECACHE_OVERRIDE: join(build, "module-cache"),
          },
        },
      );
    helper = join(build, "release/triangle-mailbox");
    client = join(build, "release/triangle-client");
  }
  const fixture = options["test-root"];
  if (fixture) {
    const canonical = realpathSync(fixture);
    if (
      !canonical.startsWith(
        realpathSync(tmpdir()) + "/triangle-package-install-",
      ) ||
      canonical !== resolve(fixture)
    )
      throw Error("Fake binaries require a canonical temporary test root");
    for (const p of [helper, client])
      if (!realpathSync(p).startsWith(canonical + "/"))
        throw Error("Fake binary must remain in test root");
  }
  const sourceFiles = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter(
      (p) =>
        p &&
        (/^(packages\/(triangle-cli|agent-worker)\/(src|runners)\/.*\.(mjs|json|sh)$)/.test(
          p,
        ) ||
          /^packages\/(triangle-cli|agent-worker)\/package\.json$/.test(p) ||
          /^scripts\/(triangle-client-service\.sh|triangle-worker-service\.sh|triangle-worker-install\.py|triangle-headless-drain-service\.sh|triangle-headless-engagement-doctor\.mjs|macos-shared-codex-app-server-host\.mjs)$/.test(
            p,
          ) ||
          /^agents\/(codex|hermes|antigravity)\/worker\/agent-worker\.json$/.test(
            p,
          ) ||
          /^deploy\/launchd\/dev\.thetriangle\.(client|agent-worker|codex-headless-drain)\.plist\.template$/.test(
            p,
          ) ||
          /^scripts\/release\/install-client-package\.mjs$/.test(p)),
    );
  // Only tracked, reviewed runtime source enters a package. No home directories,
  // environment files, build caches, profile registries or private keys are read.
  for (const relative of sourceFiles) {
    const source = join(root, relative),
      info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink())
      throw Error(`Nonregular source asset: ${relative}`);
    const target = join(stage, relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }
  const binaries = {
    node: options.node ?? process.execPath,
    "triangle-mailbox": helper,
    "triangle-client": client,
  };
  mkdirSync(join(stage, "bin"), { mode: 0o700 });
  for (const [name, path] of Object.entries(binaries)) {
    const source = realpathSync(path);
    if (!lstatSync(source).isFile()) throw Error("Binary must be regular");
    copyFileSync(source, join(stage, "bin", name));
    chmodSync(join(stage, "bin", name), 0o700);
    if (name !== "node" && !fixture) {
      if (prebuilt) {
        const metadataPath =
          options[
            name === "triangle-mailbox" ? "helper-metadata" : "client-metadata"
          ] ??
          join(dirname(source), "../install-manifest", name + "-install.json");
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        if (
          metadata.signingMode !== "public_ad_hoc" ||
          metadata.credentialCustody !== "file" ||
          metadata.sha256 !== digest(readFileSync(source))
        )
          throw Error(
            `${name} prebuilt custody/signing metadata does not match binary`,
          );
      }
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--identifier",
        "dev.thetriangle.mailbox",
        join(stage, "bin", name),
      ]);
      execFileSync("/usr/bin/codesign", [
        "--verify",
        "--strict",
        join(stage, "bin", name),
      ]);
    }
  }
  const nodeDependencies = execFileSync(
    "/usr/bin/otool",
    ["-L", join(stage, "bin/node")],
    { encoding: "utf8" },
  )
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
  if (
    nodeDependencies.some(
      (path) =>
        !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"),
    )
  )
    throw Error("Bundled Node depends on non-system dynamic libraries");
  const nodeLicense =
    options["node-license"] ??
    join(dirname(realpathSync(binaries.node)), "../LICENSE");
  if (!lstatSync(nodeLicense).isFile())
    throw Error("Matching Node LICENSE file is required (--node-license)");
  mkdirSync(join(stage, "LICENSES"), { mode: 0o700 });
  copyFileSync(nodeLicense, join(stage, "LICENSES/node-LICENSE"));
  chmodSync(join(stage, "LICENSES/node-LICENSE"), 0o600);
  const nodeInfo = JSON.parse(
    execFileSync(
      join(stage, "bin/node"),
      [
        "-p",
        'JSON.stringify({platform:process.platform,arch:process.arch,major:Number(process.versions.node.split(".")[0])})',
      ],
      { encoding: "utf8" },
    ),
  );
  if (
    nodeInfo.platform !== "darwin" ||
    nodeInfo.arch !== process.arch ||
    nodeInfo.major < 22
  )
    throw Error("Bundled Node must be native macOS Node >=22");
  const artifactCode =
    'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("worker_installer",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps({"version":m.CURRENT_MANIFEST_VERSION,"kinds":{kind:m.expected_artifacts(kind) for kind in sorted(m.AGENTS | {"supervisor"})}}))';
  const artifactManifest = JSON.parse(
    execFileSync(
      "/usr/bin/python3",
      ["-c", artifactCode, join(root, "scripts/triangle-worker-install.py")],
      { encoding: "utf8" },
    ),
  );
  for (const paths of Object.values(artifactManifest.kinds))
    for (const path of paths)
      if (!sourceFiles.includes(path))
        throw Error(`Worker artifact missing from package closure: ${path}`);
  writeFileSync(
    join(stage, "worker-artifacts.json"),
    JSON.stringify(artifactManifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  const paths = [
    "worker-artifacts.json",
    "LICENSES/node-LICENSE",
    ...sourceFiles,
    ...Object.keys(binaries).map((name) => "bin/" + name),
  ].sort();
  for (const required of [
    "packages/triangle-cli/src/cli.mjs",
    "packages/triangle-cli/src/setup.mjs",
    "packages/triangle-cli/src/setup-runtime.mjs",
    "scripts/triangle-worker-install.py",
    "scripts/release/install-client-package.mjs",
  ])
    if (!paths.includes(required))
      throw Error(`Missing tracked required asset: ${required}`);
  const manifest = {
    schema: 1,
    version: options.version,
    platform: "darwin",
    arch: process.arch,
    signingMode: "public_ad_hoc",
    credentialCustody: "file",
    testOnly: Boolean(fixture),
    files: paths.map((path) => ({
      path,
      size: lstatSync(join(stage, path)).size,
      mode: path.startsWith("bin/") ? 0o700 : 0o600,
      sha256: digest(readFileSync(join(stage, path))),
    })),
  };
  writeFileSync(
    join(stage, "package-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  mkdirSync(resolve(options.output), { recursive: true });
  const outputInfo = lstatSync(resolve(options.output));
  if (
    !outputInfo.isDirectory() ||
    outputInfo.uid !== process.getuid() ||
    (outputInfo.mode & 0o022) !== 0 ||
    realpathSync(options.output) !== resolve(options.output)
  )
    throw Error("Unsafe release output directory");
  const archive = join(
    resolve(options.output),
    `triangle-client-${options.version}-darwin-${process.arch}.tar.gz`,
  );
  const installer = join(
    resolve(options.output),
    `triangle-install-${manifest.version}.sh`,
  );
  if (
    [archive, archive + ".sha256", installer, installer + ".sha256"].some(
      (path) => {
        try {
          lstatSync(path);
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      },
    )
  )
    throw Error(
      "Release output already exists; select a new output directory/version",
    );
  execFileSync(
    "/usr/bin/tar",
    [
      "--format",
      "ustar",
      "-czf",
      archive,
      "-C",
      stage,
      "package-manifest.json",
      ...paths,
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  const sha256 = digest(readFileSync(archive));
  writeFileSync(
    archive + ".sha256",
    sha256 + "  " + archive.split("/").at(-1) + "\n",
    { flag: "wx" },
  );
  copyFileSync(join(root, "scripts/install.sh"), installer);
  chmodSync(installer, 0o700);
  const installerSHA256 = digest(readFileSync(installer));
  writeFileSync(
    installer + ".sha256",
    installerSHA256 + "  " + installer.split("/").at(-1) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      archive,
      sha256,
      installer,
      installerSHA256,
      version: manifest.version,
      files: paths.length,
      testOnly: manifest.testOnly,
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
