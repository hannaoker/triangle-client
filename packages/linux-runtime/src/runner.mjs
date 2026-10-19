import os from "node:os";
import path from "node:path";
import {
  existsSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCommandRunner } from "../../agent-worker/src/command-runner.mjs";
import {
  validateProfile,
  safeDirectory,
  safeFile,
  overlaps,
} from "./paths.mjs";
const execute = promisify(execFile);
const SYSTEM = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc/resolv.conf",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/ld.so.cache",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/alternatives",
];
export function buildSandbox(config, { systemRoots = SYSTEM } = {}) {
  validateProfile(config);
  const protectedRoots = [config.identityHome, config.stateRoot];
  if (path.basename(path.dirname(config.stateRoot)) === "agents")
    protectedRoots.push(path.dirname(path.dirname(config.stateRoot)));
  for (const trusted of [
    config.releaseRoot,
    config.bwrap,
    config.node,
    config.command,
  ])
    if (overlaps(config.modelHome, trusted))
      throw Error("Writable model home overlaps protected runtime");
  const check = (root) => {
    if (protectedRoots.some((p) => overlaps(p, root)))
      throw Error("Sandbox mount overlaps protected credentials");
  };
  for (const root of [
    config.releaseRoot,
    config.workdir,
    config.modelHome,
    config.command,
  ])
    check(root);
  if (
    overlaps(config.workdir, config.releaseRoot) ||
    overlaps(config.workdir, config.modelHome) ||
    config.workdir === "/" ||
    config.workdir === os.homedir() ||
    os.homedir().startsWith(config.workdir + "/")
  )
    throw Error("Workspace overlaps protected runtime or account home");
  safeDirectory(config.releaseRoot, { privateMode: false });
  safeDirectory(config.workdir, { privateMode: false });
  safeDirectory(config.modelHome);
  for (const file of [config.command, config.bwrap, config.node])
    safeFile(file, { executable: true, privateMode: false });
  const script = path.join(
    config.releaseRoot,
    "packages/agent-worker/runners/codex-runner.mjs",
  );
  safeFile(script, { privateMode: false });
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--dir",
    "/var",
    "--tmpfs",
    "/var/tmp",
  ];
  const mounted = [];
  const mount = (source, target, writable = false) => {
    check(source);
    check(target);
    args.push(writable ? "--bind" : "--ro-bind", source, target);
    mounted.push(target);
  };
  for (const root of systemRoots)
    if (existsSync(root)) mount(realpathSync(root), root);
  mount(config.releaseRoot, config.releaseRoot);
  if (
    !mounted.some(
      (root) =>
        config.command === root || config.command.startsWith(root + "/"),
    )
  )
    mount(config.command, config.command);
  const vendorPath = path.join(
    path.dirname(path.dirname(config.command)),
    "path",
  );
  if (existsSync(vendorPath)) {
    const st = lstatSync(vendorPath);
    if (
      !st.isDirectory() ||
      ![0, process.getuid()].includes(st.uid) ||
      st.mode & 0o022 ||
      realpathSync(vendorPath) !== vendorPath
    )
      throw Error("Unsafe vendor runtime");
    mount(vendorPath, vendorPath);
  }
  mount(config.workdir, config.workdir);
  mount(config.modelHome, config.modelHome, true);
  const environment = {
    HOME: config.modelHome,
    CODEX_HOME: config.modelHome,
    PATH: [
      ...(existsSync(vendorPath) ? [vendorPath] : []),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TRIANGLE_PROJECT_ROOT: config.workdir,
    TRIANGLE_INSTANCE_TEMP_ROOT: "/tmp",
    TMPDIR: "/tmp",
    CODEX_CLI: config.command,
  };
  for (const [key, value] of Object.entries(environment))
    args.push("--setenv", key, value);
  args.push("--chdir", config.workdir, "--", config.node, script);
  return { command: config.bwrap, args, environment };
}
export function createLinuxRunner(
  config,
  { platform = process.platform } = {},
) {
  validateProfile(config);
  const linux = () => {
    if (platform !== "linux") throw Error("Managed execution requires Linux");
  };
  return {
    async probe({ signal } = {}) {
      linux();
      const root = realpathSync(
        mkdtempSync(path.join(os.tmpdir(), "triangle-bwrap-probe-")),
      );
      try {
        for (const d of ["model", "workspace", "secrets"])
          mkdirSync(path.join(root, d), { mode: 0o700 });
        const secret = path.join(root, "secrets/canary");
        writeFileSync(secret, "private", { mode: 0o600 });
        const sandbox = buildSandbox({
          ...config,
          modelHome: path.join(root, "model"),
          workdir: path.join(root, "workspace"),
        });
        const nonce = randomBytes(16).toString("hex");
        const hidden = [
          secret,
          path.join(config.identityHome, "owner-key.json"),
          config.stateRoot,
          `/proc/${process.pid}/root${secret}`,
        ];
        const code = `import fs from 'node:fs';for(const p of ${JSON.stringify(hidden)})if(fs.existsSync(p))process.exit(31);fs.writeFileSync(process.env.HOME+'/probe','ok');try{fs.writeFileSync(process.env.TRIANGLE_PROJECT_ROOT+'/blocked','no');process.exit(32)}catch{};console.log(${JSON.stringify(nonce)});`;
        const args = sandbox.args
          .slice(0, sandbox.args.indexOf("--") + 1)
          .concat(config.node, "--input-type=module", "-e", code);
        const result = await execute(sandbox.command, args, {
          env: sandbox.environment,
          timeout: 15000,
          maxBuffer: 128 * 1024,
          signal,
        });
        if (result.stdout.trim() !== nonce) throw Error("Sandbox probe failed");
        return { ok: true };
      } catch {
        throw Error(
          "Linux sandbox probe failed; bubblewrap and user namespaces are required",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    async run(request, { signal } = {}) {
      linux();
      try {
        const sandbox = buildSandbox(config);
        return await createCommandRunner({
          ...sandbox,
          timeoutMs: config.runnerTimeoutMs,
        }).run(request, { signal });
      } catch (cause) {
        if (cause.name === "AbortError") throw cause;
        const error = Error("Linux runner failed");
        error.code = "runner_failed";
        error.knownFailure = false;
        throw error;
      }
    },
  };
}
