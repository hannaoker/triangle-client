// macOS adapter for guided setup. Owner protocol and key creation stay in setup.mjs.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStateError } from "./errors.mjs";
import { openCustody } from "./custody.mjs";

const KINDS = new Set(["codex", "hermes", "antigravity", "supervisor"]);
const HARNESSES = {
  codex: {
    name: "Codex",
    commands: ["codex"],
    overrides: ["CODEX_CLI"],
    adapter: "codex",
  },
  hermes: {
    name: "Hermes",
    commands: ["hermes"],
    overrides: ["HERMES_CLI"],
    adapter: "hermes",
  },
  antigravity: {
    name: "Antigravity",
    commands: ["agy"],
    overrides: ["ANTIGRAVITY_CLI", "AGY_CLI"],
    adapter: "antigravity",
  },
  cursor: {
    name: "Cursor",
    commands: ["cursor-agent"],
    overrides: ["CURSOR_CLI"],
    adapter: "cursor-acp",
  },
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
const fail = (message) => {
  throw new LocalStateError(message);
};
export const profileInstanceId = (profile) =>
  hash(
    Buffer.concat([
      Buffer.from("triangle-client-instance-v1"),
      Buffer.from([0]),
      Buffer.from(profile),
    ]),
  );
function directory(dir, { create = false, privateMode = true } = {}) {
  const absolute = path.resolve(dir);
  if (!existsSync(absolute)) {
    if (!create)
      fail("Required installation directory is missing. Reinstall Triangle.");
    directory(path.dirname(absolute), { create: true, privateMode: false });
    mkdirSync(absolute, { mode: 0o700 });
  }
  const s = lstatSync(absolute);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    realpathSync(absolute) !== absolute ||
    ![process.getuid?.(), 0].includes(s.uid) ||
    s.mode & 0o022
  )
    fail("Unsafe or noncanonical installation directory.");
  if (privateMode && ((s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()))
    fail("Triangle installation directories must be private and owned by you.");
  return absolute;
}
function regular(file, { executable = false, privateMode = false } = {}) {
  const p = path.resolve(file);
  let s;
  try {
    s = lstatSync(p);
  } catch {
    fail("Required installation file is missing. Reinstall Triangle.");
  }
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    realpathSync(p) !== p ||
    ![process.getuid?.(), 0].includes(s.uid) ||
    s.mode & 0o022 ||
    (privateMode && (s.uid !== process.getuid?.() || s.mode & 0o077))
  )
    fail("Unsafe installation file or symlink.");
  if (executable)
    try {
      accessSync(p, constants.X_OK);
    } catch {
      fail("Required executable is not runnable.");
    }
  return p;
}
function readJson(file, optional = false) {
  if (optional && !existsSync(file)) return null;
  regular(file, { privateMode: true });
  if (lstatSync(file).size > 128 * 1024)
    fail("Installation metadata is too large.");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail("Invalid installation metadata.");
  }
}
function atomicJson(file, data) {
  directory(path.dirname(file), { create: true });
  if (existsSync(file)) regular(file, { privateMode: true });
  const temp = file + ".tmp-" + randomBytes(6).toString("hex");
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
function copyPrivate(source, dest, mode = 0o600) {
  regular(source);
  directory(path.dirname(dest), { create: true });
  if (existsSync(dest)) regular(dest, { privateMode: true });
  copyFileSync(source, dest, constants.COPYFILE_EXCL);
  chmodSync(dest, mode);
}
function artifactPaths(releaseRoot, kind) {
  const metadata = readJson(path.join(releaseRoot, "worker-artifacts.json"));
  const paths = metadata?.kinds?.[kind];
  if (
    metadata.version !== 8 ||
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 200 ||
    new Set(paths).size !== paths.length
  )
    fail("Invalid worker artifact metadata. Reinstall Triangle.");
  for (const p of paths)
    if (
      typeof p !== "string" ||
      p.includes("\\") ||
      p.includes("\0") ||
      path.isAbsolute(p) ||
      p.split("/").some((x) => !x || x === "." || x === "..") ||
      (!p.startsWith("packages/") && !p.startsWith("agents/"))
    )
      fail("Invalid worker artifact path.");
  return paths;
}
function verifyReleaseFiles(releaseRoot, paths) {
  const manifest = readJson(path.join(releaseRoot, "package-manifest.json"));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files))
    fail("Invalid installed release manifest. Reinstall Triangle.");
  const files = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (files.size !== manifest.files.length)
    fail("Duplicate release artifact metadata.");
  for (const relative of paths) {
    const entry = files.get(relative);
    const file = regular(path.join(releaseRoot, relative));
    if (
      !entry ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      lstatSync(file).size !== entry.size ||
      hash(readFileSync(file)) !== entry.sha256
    )
      fail(
        "Installed release artifact integrity mismatch. Reinstall Triangle.",
      );
  }
}
function discoverRoots(kind, cli, accountHome) {
  const roots = new Set([path.dirname(cli)]);
  if (kind === "hermes") {
    const text = readFileSync(cli, "utf8");
    const match = text.match(
      /^exec\s+(?:"(\/[^"\n$`\\]+)"|(\/[A-Za-z0-9._+/@%:,=-]+))\s+"\$@"\s*$/m,
    );
    if (!match)
      fail(
        "Hermes needs its supported absolute-path launcher. Reinstall Hermes before setup.",
      );
    const target = regular(realpathSync(match[1] ?? match[2]), {
      executable: true,
    });
    const first = readFileSync(target, "utf8").split("\n")[0];
    if (!first.startsWith("#!/"))
      fail("Hermes launcher needs an absolute Python interpreter.");
    const interpreter = regular(realpathSync(first.slice(2).split(/\s+/)[0]), {
      executable: true,
    });
    const venv = path.dirname(path.dirname(target));
    roots.add(venv);
    roots.add(path.dirname(path.dirname(interpreter)));
    roots.add(path.dirname(venv));
    const config = path.join(venv, "pyvenv.cfg");
    if (existsSync(config)) {
      regular(config);
      const base = readFileSync(config, "utf8").match(
        /^\s*home\s*=\s*(.+)\s*$/m,
      )?.[1];
      if (base)
        roots.add(
          path.dirname(realpathSync(directory(base, { privateMode: false }))),
        );
    }
  }
  if (kind === "antigravity")
    for (const name of ["antigravity-cli", "config"]) {
      const p = path.join(accountHome, ".gemini", name);
      if (existsSync(p)) roots.add(directory(p, { privateMode: false }));
    }
  return [...roots].join(":");
}

/** Pure Node equivalent of the existing content-addressed v8 worker staging contract. */
export function stageRuntimeBundle({
  appRoot,
  releaseRoot,
  kind,
  cli = null,
  accountHome = os.homedir(),
}) {
  if (!KINDS.has(kind)) fail("Invalid runtime kind.");
  directory(appRoot);
  directory(releaseRoot, { privateMode: false });
  const runtime = directory(path.join(appRoot, "worker-runtime"), {
    create: true,
  });
  const bundles = directory(path.join(runtime, "bundles"), { create: true });
  const sourceNode = regular(path.join(releaseRoot, "bin/node"), {
    executable: true,
  });
  const paths = artifactPaths(releaseRoot, kind);
  verifyReleaseFiles(releaseRoot, [
    "bin/node",
    "worker-artifacts.json",
    ...paths,
  ]);
  const artifacts = Object.fromEntries(
    paths.map((p) => [
      p,
      hash(readFileSync(regular(path.join(releaseRoot, p)))),
    ]),
  );
  const nodeSHA256 = hash(readFileSync(sourceNode));
  const address = hash(
    [
      kind,
      nodeSHA256,
      ...Object.keys(artifacts)
        .sort()
        .map((p) => `${p}=${artifacts[p]}`),
    ].join("\n") + "\n",
  );
  const bundle = path.join(bundles, address);
  if (existsSync(bundle)) {
    directory(bundle);
    const installedNode = regular(path.join(bundle, "bin/node"), {
      executable: true,
      privateMode: true,
    });
    if (hash(readFileSync(installedNode)) !== nodeSHA256)
      fail("Installed runtime integrity mismatch.");
    for (const p of paths)
      if (
        hash(
          readFileSync(regular(path.join(bundle, p), { privateMode: true })),
        ) !== artifacts[p]
      )
        fail("Installed runtime artifact is corrupt.");
  } else {
    const stage = path.join(
      bundles,
      ".stage-" + randomBytes(8).toString("hex"),
    );
    directory(stage, { create: true });
    try {
      copyPrivate(sourceNode, path.join(stage, "bin/node"), 0o500);
      for (const p of paths)
        copyPrivate(path.join(releaseRoot, p), path.join(stage, p));
      renameSync(stage, bundle);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  let environment = {
    PATH: path.join(bundle, "bin") + ":/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  if (kind !== "supervisor") {
    cli = regular(realpathSync(cli), { executable: true });
    environment = {
      ...environment,
      PATH: [path.join(bundle, "bin"), path.dirname(cli), "/usr/bin", "/bin"]
        .filter((x, i, a) => a.indexOf(x) === i)
        .join(":"),
      TRIANGLE_PROJECT_ROOT: bundle,
      TRIANGLE_RUNTIME_ROOTS: discoverRoots(kind, cli, accountHome),
      [kind === "codex"
        ? "CODEX_CLI"
        : kind === "hermes"
          ? "HERMES_CLI"
          : "ANTIGRAVITY_CLI"]: cli,
    };
  }
  const manifest = {
    version: 8,
    nodeSHA256,
    projectRoot: bundle,
    environment,
    artifacts,
  };
  atomicJson(path.join(runtime, kind + ".manifest.json"), manifest);
  return manifest;
}
async function runChild(command, args, { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "",
      stderr = "",
      bytes = 0;
    // Lifecycle failure can wait twice: activation, then restoration of the
    // previous service. Keep the outer bound beyond both readiness windows.
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.stdout.on("data", (b) => {
      bytes += b.length;
      if (bytes > 256 * 1024) child.kill("SIGTERM");
      else stdout += b;
    });
    child.stderr.on("data", (b) => {
      bytes += b.length;
      if (bytes > 256 * 1024) child.kill("SIGTERM");
      else stderr += b;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new LocalStateError("Unable to run the installed Triangle component."),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function createSetupRuntime({
  env = process.env,
  platform = process.platform,
  accountHome = os.homedir(),
  releaseRoot = fileURLToPath(new URL("../../../", import.meta.url)),
  run = runChild,
} = {}) {
  accountHome = path.resolve(accountHome);
  releaseRoot = path.resolve(releaseRoot);
  const appRoot = path.join(
    accountHome,
    "Library/Application Support/The Triangle",
  );
  const helper = path.join(appRoot, "bin/triangle-mailbox");
  const client = path.join(appRoot, "bin/triangle-client");
  const clientRoot = path.join(appRoot, "client");
  const subprocessEnv = {
    HOME: accountHome,
    PATH: env.PATH ?? "/usr/bin:/bin",
    LANG: env.LANG ?? "en_US.UTF-8",
    LC_ALL: env.LC_ALL ?? "en_US.UTF-8",
    TRIANGLE_CREDENTIAL_CUSTODY: "file",
  };
  function selected(harness) {
    const h = HARNESSES[harness];
    if (!h) fail("Unsupported harness.");
    const choices = [
      ...h.overrides.map((k) => env[k]).filter(Boolean),
      ...h.commands.flatMap((n) =>
        (env.PATH ?? "")
          .split(path.delimiter)
          .filter((p) => p && path.isAbsolute(p))
          .map((p) => path.join(p, n)),
      ),
    ];
    for (const p of choices) {
      try {
        return regular(realpathSync(p), { executable: true });
      } catch {}
    }
    fail(
      `${h.name} is not installed or its CLI is not executable. Install and sign in to ${h.name}, then rerun triangle setup.`,
    );
  }
  function instance(profile) {
    return readJson(
      path.join(clientRoot, "instances", profileInstanceId(profile) + ".json"),
      true,
    );
  }
  function binding(profile) {
    return readJson(
      path.join(
        appRoot,
        "profiles-v1",
        "profile-" + Buffer.from(profile).toString("hex") + ".json",
      ),
      true,
    );
  }
  function validateChoices({
    profile,
    harness,
    workdir,
    workdirExplicit = false,
    home,
  }) {
    if (platform !== "darwin")
      fail(
        "Background service setup currently supports macOS. Use --identity-only.",
      );
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(profile)) fail("Invalid profile name.");
    directory(accountHome, { privateMode: false });
    directory(appRoot);
    regular(helper, { executable: true, privateMode: true });
    regular(client, { executable: true, privateMode: true });
    regular(path.join(releaseRoot, "bin/node"), { executable: true });
    const artifacts = artifactPaths(releaseRoot, "supervisor");
    verifyReleaseFiles(releaseRoot, [
      "bin/node",
      "worker-artifacts.json",
      ...artifacts,
    ]);
    directory(workdir, { privateMode: false });
    const cli = selected(harness),
      adapter = HARNESSES[harness].adapter;
    const current = instance(profile);
    if (current && current.runtimeAdapter !== adapter)
      fail(
        "This profile already uses a different harness. Choose a new profile.",
      );
    const bound = binding(profile);
    if (bound) {
      const expectedRoot = path.join(path.resolve(home), "agents") + path.sep;
      if (
        typeof bound.keyFile !== "string" ||
        !bound.keyFile.startsWith(expectedRoot) ||
        path.basename(bound.keyFile) !== "workload-key.json"
      )
        fail(
          "Profile identity conflicts with this owner home. Choose another profile.",
        );
    }
    if (current && !bound)
      fail(
        "Existing profile has no verified identity binding. Run triangle doctor.",
      );
    const headless =
      !current ||
      current.deliveryMode ===
        (harness === "codex" ? "headless-app-server" : "headless-cursor-acp");
    let configuredHome;
    if (headless && (harness === "codex" || harness === "cursor")) {
      const config = readJson(
        path.join(
          clientRoot,
          harness === "codex"
            ? "headless-runtime-binding.json"
            : "cursor-acp-runtime-binding.json",
        ),
        true,
      );
      if (config) {
        if (
          config.version !== (harness === "codex" ? 2 : 1) ||
          !config.common ||
          !Array.isArray(config.profiles)
        )
          fail(
            "Existing headless runtime binding is invalid. Run triangle doctor.",
          );
        configuredHome =
          config.common[harness === "codex" ? "codexHome" : "cursorHome"];
        if (
          typeof configuredHome !== "string" ||
          !path.isAbsolute(configuredHome)
        )
          fail("Existing harness home is invalid.");
        directory(configuredHome);
        if (typeof config.common.workingDirectory !== "string")
          fail("Existing harness working directory is invalid.");
        if (!workdirExplicit)
          workdir = path.resolve(config.common.workingDirectory);
        if (
          config.common.command !== cli ||
          path.resolve(config.common.workingDirectory) !== path.resolve(workdir)
        )
          fail(
            "The existing harness runtime has a different executable or working directory. Reuse those settings or choose its existing working directory.",
          );
      }
    }
    if (headless && harness === "codex") {
      const target = path.join(
        configuredHome ?? path.join(appRoot, "model-state/codex-runtime-home"),
        "auth.json",
      );
      const source = path.join(accountHome, ".codex/auth.json");
      if (!existsSync(target) && (configuredHome || !existsSync(source)))
        fail(
          'Sign in to Codex first. For an isolated sign-in use CODEX_HOME="' +
            path.dirname(target) +
            '" codex login, then rerun setup.',
        );
      regular(existsSync(target) ? target : source, { privateMode: true });
    }
    let agentId;
    if (bound) {
      agentId = path.basename(path.dirname(bound.keyFile));
      if (
        !/^agent_[a-f0-9]{32}$/.test(agentId) ||
        bound.keyFile !==
          path.join(path.resolve(home), "agents", agentId, "workload-key.json")
      )
        fail(
          "Profile identity conflicts with this owner home. Choose another profile.",
        );
      regular(bound.keyFile, { privateMode: true });
    }
    return {
      cli,
      adapter,
      current,
      bound,
      workdir,
      configuredHome,
      agentId,
      headless,
    };
  }
  async function call(command, args, description) {
    const r = await run(command, args, {
      env: subprocessEnv,
      cwd: accountHome,
    });
    if (r.code !== 0)
      fail(
        `${description} failed (exit ${r.code}). Your MESH identity is saved; rerun triangle setup --resume.`,
      );
    let data;
    try {
      data = JSON.parse(r.stdout || "{}");
    } catch {
      fail(`${description} returned invalid status. Run triangle doctor.`);
    }
    return data;
  }
  async function preflight(options) {
    const checked = validateChoices(options);
    return {
      state: "ready",
      platform: "darwin",
      harness: options.harness,
      workdir: checked.workdir,
      agentId: checked.agentId,
    };
  }
  function configureHeadless({
    profile,
    harness,
    workdir,
    cli,
    configuredHome,
  }) {
    if (harness !== "codex" && harness !== "cursor") return;
    const installationFile = path.join(clientRoot, "installation.json");
    let installation = readJson(installationFile, true);
    if (!installation) {
      installation = {
        version: 1,
        installationId: "inst_" + randomBytes(12).toString("base64url"),
      };
      atomicJson(installationFile, installation);
    }
    if (!/^inst_[A-Za-z0-9_-]{10,75}$/.test(installation.installationId))
      fail("Invalid installation identity.");
    const model = path.join(appRoot, "model-state");
    directory(model, { create: true });
    const runtimeHome =
      configuredHome ??
      path.join(
        model,
        harness === "codex" ? "codex-runtime-home" : "cursor-acp-runtime-home",
      );
    directory(runtimeHome, { create: true });
    if (harness === "codex" && !existsSync(path.join(runtimeHome, "auth.json")))
      copyPrivate(
        path.join(accountHome, ".codex/auth.json"),
        path.join(runtimeHome, "auth.json"),
      );
    const file = path.join(
      clientRoot,
      harness === "codex"
        ? "headless-runtime-binding.json"
        : "cursor-acp-runtime-binding.json",
    );
    const document = readJson(file, true) ?? {
      version: harness === "codex" ? 2 : 1,
      common: {
        adapterVersion: "1",
        installationId: installation.installationId,
        workingDirectory: workdir,
        [harness === "codex" ? "codexHome" : "cursorHome"]: runtimeHome,
        command: cli,
        pollIntervalMs: 30000,
      },
      profiles: [],
    };
    if (document.common.installationId !== installation.installationId)
      fail("Existing runtime binding belongs to another installation.");
    const existing = document.profiles.find((p) => p.profile === profile);
    const stateRoot = path.join(
      model,
      harness === "codex" ? "headless-drain" : "cursor-acp-drain",
      profile,
    );
    directory(stateRoot, { create: true });
    if (!existing)
      document.profiles.push({
        profile,
        instanceId: profileInstanceId(profile),
        stateRoot,
      });
    else if (existing.instanceId !== profileInstanceId(profile))
      fail("Existing runtime profile identity is invalid.");
    atomicJson(file, document);
  }
  async function configure(options) {
    return openCustody(path.join(clientRoot, ".setup-runtime-lock")).withLock(
      async () => {
        const { profile, harness, agent, keyFile } = options;
        const checked = validateChoices(options);
        const expectedKey = path.join(
          path.resolve(options.home),
          "agents",
          agent.agent_id,
          "workload-key.json",
        );
        if (path.resolve(keyFile) !== expectedKey)
          fail("Unexpected agent key file.");
        regular(keyFile, { privateMode: true });
        if (checked.bound && checked.bound.keyFile !== expectedKey)
          fail(
            "Profile is already bound to another agent. No binding was changed.",
          );
        const verified = await call(
          helper,
          ["bind", "--profile", profile, "--key-file", expectedKey],
          "Profile verification",
        );
        if (
          verified.status !== "verified" ||
          verified.agentId !== agent.agent_id
        )
          fail(
            "The helper verified a different identity. Run triangle doctor.",
          );
        stageRuntimeBundle({
          appRoot,
          releaseRoot,
          kind: "supervisor",
          accountHome,
        });
        if (harness !== "cursor")
          stageRuntimeBundle({
            appRoot,
            releaseRoot,
            kind: harness,
            cli: checked.cli,
            accountHome,
          });
        if (checked.headless)
          configureHeadless({
            ...options,
            workdir: checked.workdir,
            cli: checked.cli,
            configuredHome: checked.configuredHome,
          });
        if (!checked.current)
          await call(
            client,
            [
              "agent",
              "add",
              "--profile",
              profile,
              "--runtime",
              checked.adapter,
            ],
            "Service setup",
          );
        else
          await call(
            client,
            ["agent", "enable", "--profile", profile],
            "Service activation",
          );
        const actual = await call(
          helper,
          ["status", "--profile", profile],
          "Profile status",
        );
        if (actual.status !== "verified" || actual.agentId !== agent.agent_id)
          fail("Profile did not remain verified. Run triangle doctor.");
        const service = await run(
          "/bin/launchctl",
          ["print", `gui/${process.getuid()}/dev.thetriangle.client`],
          { env: subprocessEnv, cwd: accountHome },
        );
        if (
          service.code !== 0 ||
          !/(?:^|\n)\s*state = running\b/.test(service.stdout)
        )
          fail(
            "The background service is not running. Run triangle setup --resume.",
          );
        return {
          state: "running",
          profile,
          harness,
          agentId: agent.agent_id,
          authority: actual.origin,
          next_action: "Your agent is ready to receive messages.",
        };
      },
    );
  }
  async function status({ profile }) {
    const identity = await call(
      helper,
      ["status", "--profile", profile],
      "Profile status",
    );
    const local = instance(profile);
    const service = await run(
      "/bin/launchctl",
      ["print", `gui/${process.getuid()}/dev.thetriangle.client`],
      { env: subprocessEnv, cwd: accountHome },
    );
    return {
      state:
        identity.status === "verified" &&
        local?.enabled &&
        service.code === 0 &&
        /(?:^|\n)\s*state = running\b/.test(service.stdout)
          ? "running"
          : "needs_attention",
      profile,
      identity: identity.status,
      enabled: local?.enabled ?? false,
    };
  }
  return { preflight, configure, status };
}
