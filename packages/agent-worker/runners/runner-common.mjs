import { spawn } from "node:child_process";
import { existsSync, globSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { createRunnerEnvironment } from "../src/command-runner.mjs";

const MAX_BYTES = 1024 * 1024;

function sandboxLiteral(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Sandbox paths must not contain control characters");
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function canonicalRoot(value, name) {
  if (!value || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must be an absolute canonical path`);
  }
  const resolved = path.resolve(value);
  const canonical = realpathSync(resolved);
  return canonical;
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function rootList(value, name) {
  const entries = (value || "").split(path.delimiter).filter(Boolean);
  if (entries.some((entry) => lstatSync(entry).isSymbolicLink())) throw new Error(`${name} must not contain symlink roots`);
  const roots = entries.map((entry) => canonicalRoot(entry, name));
  if (!roots.length) throw new Error(`${name} must name at least one dedicated root`);
  if (new Set(roots).size !== roots.length) throw new Error(`${name} contains a duplicate root`);
  return roots;
}

function requirePlainComponents(homeInput, target, name, { create = false } = {}) {
  const home = path.resolve(homeInput);
  const resolved = path.resolve(target);
  if (resolved !== target || (resolved !== home && !resolved.startsWith(`${home}${path.sep}`))) {
    throw new Error(`${name} must be a lexical descendant of HOME`);
  }
  let current = home;
  for (const component of path.relative(home, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!existsSync(current)) {
      if (!create) throw new Error(`${name} must be an existing directory without symlink components`);
      mkdirSync(current, { mode: 0o700 });
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${name} must not contain symlink components`);
    if (!stat.isDirectory()) throw new Error(`${name} components must be directories`);
  }
  const canonical = realpathSync(resolved);
  const expectedCanonical = path.join(realpathSync(home), path.relative(home, resolved));
  if (canonical !== expectedCanonical) throw new Error(`${name} must remain beneath canonical HOME without symlink aliases`);
  return canonical;
}

function runtimeFamilies(env, activeWorker) {
  const families = [path.dirname(realpathSync(process.execPath))];
  const aliases = [];
  const recordSymlinkComponents = (value) => {
    const absolute = path.resolve(value);
    let current = path.parse(absolute).root;
    for (const component of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) aliases.push(current);
    }
  };
  const resolveSymlinkChain = (value) => {
    let current = value;
    recordSymlinkComponents(current);
    while (lstatSync(current).isSymbolicLink()) {
      aliases.push(current);
      current = path.resolve(path.dirname(current), readlinkSync(current));
      recordSymlinkComponents(current);
    }
    return realpathSync(current);
  };
  const activeCliName = activeWorker === "codex" ? "CODEX_CLI" : (activeWorker === "hermes" ? "HERMES_CLI" : "ANTIGRAVITY_CLI");
  for (const name of [activeCliName]) {
    const cli = env[name];
    if (!cli || !path.isAbsolute(cli) || !existsSync(cli)) continue;
    const executable = realpathSync(cli);
    families.push(path.dirname(executable));
    if (name !== "HERMES_CLI") continue;
    const wrapper = readFileSync(executable, "utf8");
    const target = wrapper.match(/^exec\s+"([^"\n]+)"\s+"\$@"\s*$/m)?.[1];
    if (!target || !path.isAbsolute(target) || !existsSync(target)) throw new Error("Installed Hermes wrapper has an unsupported execution chain");
    const entry = realpathSync(target);
    const interpreterPath = readFileSync(entry, "utf8").split(/\r?\n/, 1)[0]?.replace(/^#!/, "").split(/\s+/, 1)[0];
    if (!interpreterPath || !path.isAbsolute(interpreterPath) || !existsSync(interpreterPath)) throw new Error("Installed Hermes interpreter is unavailable");
    const venv = path.dirname(path.dirname(entry));
    const interpreterPrefix = path.dirname(path.dirname(resolveSymlinkChain(interpreterPath)));
    const agentRoot = path.dirname(venv);
    families.push(venv, interpreterPrefix, agentRoot);
    for (const finder of globSync(path.join(venv, "lib", "python*", "site-packages", "__editable___*_finder.py"))) {
      const mappingLine = readFileSync(finder, "utf8").match(/^MAPPING:.*$/m)?.[0] || "";
      for (const match of mappingLine.matchAll(/'([^']+)'/g)) {
        if (!path.isAbsolute(match[1])) continue;
        const candidate = existsSync(match[1]) ? match[1] : (existsSync(`${match[1]}.py`) ? `${match[1]}.py` : null);
        if (!candidate) continue;
        const sourceRoot = realpathSync(candidate);
        if (!sourceRoot.startsWith(`${agentRoot}${path.sep}`) || sourceRoot.startsWith(`${venv}${path.sep}`)) throw new Error("Hermes editable runtime escapes its installation root");
        families.push(sourceRoot);
      }
    }
  }
  return { families: [...new Set(families.map((entry) => realpathSync(entry)))], aliases: [...new Set(aliases)] };
}

function collapseToOuterRoots(roots) {
  return roots.filter((root) => !roots.some((other) => other !== root && root.startsWith(`${other}${path.sep}`)));
}

function sandboxRegex(value) {
  return sandboxLiteral(value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
}

export function sandboxCommand(command, args, env = process.env) {
  if (process.platform !== "darwin") return { command, args };
  const project = canonicalRoot(env.TRIANGLE_PROJECT_ROOT, "TRIANGLE_PROJECT_ROOT");
  const credentials = canonicalRoot(env.TRIANGLE_CREDENTIAL_ROOT, "TRIANGLE_CREDENTIAL_ROOT");
  if (!env.HOME) throw new Error("HOME is required for application-owned sandbox state");
  const homeInput = path.resolve(env.HOME);
  const home = canonicalRoot(env.HOME, "HOME");
  const expectedModelStateInput = path.join(homeInput, "Library", "Application Support", "The Triangle", "model-state");
  if (env.TRIANGLE_MODEL_STATE_BASE !== expectedModelStateInput) throw new Error("TRIANGLE_MODEL_STATE_BASE must lexically equal the application-owned model state base");
  const modelStateBase = requirePlainComponents(homeInput, expectedModelStateInput, "TRIANGLE_MODEL_STATE_BASE");
  const modelRoots = rootList(env.TRIANGLE_MODEL_ROOTS, "TRIANGLE_MODEL_ROOTS");
  const runtimeRoots = collapseToOuterRoots(rootList(env.TRIANGLE_RUNTIME_ROOTS, "TRIANGLE_RUNTIME_ROOTS"));
  const writableRuntimeRoots = typeof env.TRIANGLE_WRITABLE_RUNTIME_ROOTS === "string" && env.TRIANGLE_WRITABLE_RUNTIME_ROOTS.trim()
    ? rootList(env.TRIANGLE_WRITABLE_RUNTIME_ROOTS, "TRIANGLE_WRITABLE_RUNTIME_ROOTS")
    : [];
  const instanceId = env.TRIANGLE_INSTANCE_ID;
  if (typeof instanceId !== "string" || !/^[a-f0-9]{64}$/.test(instanceId)) throw new Error("TRIANGLE_INSTANCE_ID must be an opaque 64-character identifier");
  if (overlaps(project, credentials)) {
    throw new Error("Credential and project roots must not overlap");
  }
  const expectedModelStateBase = path.join(home, "Library", "Application Support", "The Triangle", "model-state");
  if (modelStateBase !== expectedModelStateBase) throw new Error("TRIANGLE_MODEL_STATE_BASE must equal the application-owned model state base");
  if (modelStateBase === "/" || (home && (modelStateBase === home || home.startsWith(`${modelStateBase}${path.sep}`)))) throw new Error("Model state base is an unsafe HOME ancestor or filesystem root");
  if (home) {
    const forbiddenHomeRoots = ["Documents", "Desktop", "Downloads", "Library/Safari", "Library/Application Support/Google", "Library/Application Support/Firefox"].map((entry) => path.join(home, entry));
    if (forbiddenHomeRoots.some((entry) => modelStateBase === entry || modelStateBase.startsWith(`${entry}${path.sep}`))) {
      throw new Error("Model state base must not use documents, browser, or unrelated application data");
    }
  }
  for (const modelRoot of modelRoots) {
    if (!modelRoot.startsWith(`${modelStateBase}${path.sep}`)) throw new Error("Every model root must be strictly beneath the model state base");
  }
  const expectedInstanceModelRoot = path.join(modelStateBase, "instances", instanceId);
  if (modelRoots.length !== 1 || modelRoots[0] !== expectedInstanceModelRoot) throw new Error("Model root must select the exact Triangle instance");
  for (const candidate of [...modelRoots, ...runtimeRoots]) {
    if (candidate === "/" || (home && candidate === home)) throw new Error("Model/runtime root is an unsafe broad HOME or filesystem root");
    if (overlaps(candidate, credentials)) throw new Error("Model/runtime root must not overlap the credential root");
  }
  const workerNames = [["codex", env.CODEX_HOME], ["hermes", env.HERMES_HOME], ["antigravity", env.ANTIGRAVITY_HOME]].filter(([, value]) => Boolean(value));
  if (workerNames.length !== 1) throw new Error("Exactly one active worker model home is required");
  const activeWorker = workerNames[0][0];
  const allCliNames = { codex: "CODEX_CLI", hermes: "HERMES_CLI", antigravity: "ANTIGRAVITY_CLI" };
  for (const [worker, cliKey] of Object.entries(allCliNames)) {
    if (worker !== activeWorker && typeof env[cliKey] === "string") {
      throw new Error(`${cliKey} is an inactive CLI for the ${activeWorker} worker`);
    }
  }
  const { families: approvedRuntimeFamilies, aliases: runtimeAliases } = runtimeFamilies(env, activeWorker);
  const signedSystemFamilies = ["/System", "/usr", "/bin", "/sbin", "/Library/Apple"].filter(existsSync).map((entry) => realpathSync(entry));
  for (const runtimeRoot of runtimeRoots) {
    if (![...signedSystemFamilies, ...approvedRuntimeFamilies].some((family) => runtimeRoot === family || runtimeRoot.startsWith(`${family}${path.sep}`))) {
      throw new Error("Every runtime root must belong to an approved executable installation chain");
    }
  }
  const temporaryInput = path.join(homeInput, "Library", "Caches", "The Triangle", "instances", instanceId);
  if (env.TRIANGLE_INSTANCE_TEMP_ROOT !== temporaryInput) throw new Error("Instance temp root must select the exact Triangle instance");
  const temporary = requirePlainComponents(homeInput, temporaryInput, "worker temporary root", { create: true });
  for (const writableRoot of writableRuntimeRoots) {
    if (!runtimeRoots.some((entry) => writableRoot === entry || writableRoot.startsWith(`${entry}${path.sep}`))) {
      throw new Error("Every writable runtime root must be within a runtime root");
    }
    if (overlaps(writableRoot, credentials) || overlaps(writableRoot, project) || overlaps(writableRoot, modelStateBase) || overlaps(writableRoot, temporary)) {
      throw new Error("Writable runtime root must not overlap credential, project, model, or temp roots");
    }
  }
  const isolatedRoots = [project, credentials, temporary, ...runtimeRoots];
  for (let left = 0; left < isolatedRoots.length; left += 1) {
    for (let right = left + 1; right < isolatedRoots.length; right += 1) {
      if (overlaps(isolatedRoots[left], isolatedRoots[right])) {
        throw new Error("Project, credential, temp, model, and runtime roots must not overlap or contain ancestors");
      }
    }
  }
  for (let left = 0; left < modelRoots.length; left += 1) {
    for (let right = left + 1; right < modelRoots.length; right += 1) {
      if (overlaps(modelRoots[left], modelRoots[right])) throw new Error("Model roots must not overlap or contain ancestors");
    }
    if (isolatedRoots.some((entry) => overlaps(modelRoots[left], entry)) || isolatedRoots.some((entry) => overlaps(modelStateBase, entry))) {
      throw new Error("Model state must not overlap project, credential, temp, or runtime roots");
    }
  }
  for (const [name, value] of [["CODEX_HOME", env.CODEX_HOME], ["HERMES_HOME", env.HERMES_HOME], ["ANTIGRAVITY_HOME", env.ANTIGRAVITY_HOME]]) {
    if (!value) continue;
    const cliHome = canonicalRoot(value, name);
    if (!modelRoots.some((entry) => cliHome === entry || cliHome.startsWith(`${entry}${path.sep}`))) throw new Error(`${name} must be within a model root`);
  }
  const locatedCommand = path.isAbsolute(command)
    ? realpathSync(command)
    : (env.PATH || "").split(path.delimiter).map((directory) => path.join(directory, command)).find(existsSync);
  if (!locatedCommand) throw new Error("Reasoning command is unavailable");
  const commandPath = realpathSync(locatedCommand);
  const systemRoots = ["/System", "/usr/bin", "/usr/lib", "/usr/share", "/bin", "/sbin", "/Library/Apple", "/Library/Preferences", "/private/etc", "/private/var/db"].filter(existsSync).map((entry) => realpathSync(entry));
  const readableRoots = [...systemRoots, project, ...modelRoots, ...runtimeRoots];
  if (!readableRoots.some((entry) => commandPath === entry || commandPath.startsWith(`${entry}${path.sep}`))) {
    throw new Error("Reasoning command must be beneath an explicit runtime or model root");
  }
  const ancestorRoots = new Set(["/"]);
  for (const root of [...readableRoots, temporary]) {
    for (let parent = path.dirname(root); parent !== "/"; parent = path.dirname(parent)) ancestorRoots.add(parent);
  }
  for (const alias of runtimeAliases) for (let parent = path.dirname(alias); parent !== "/"; parent = path.dirname(parent)) ancestorRoots.add(parent);
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process*)", "(allow signal)", `(allow file-read-data (require-all (literal "/") (vnode-type DIRECTORY)))`, "(allow sysctl-read)", "(allow mach-lookup)", "(allow ipc-posix*)",
    "(allow system-socket)", "(allow network*)",
    ...[...ancestorRoots].map((entry) => `(allow file-read-metadata (literal "${sandboxLiteral(entry)}"))`),
    // macOS sandbox-exec uses directory file-read-data for path traversal as well
    // as listing. Limit this accepted name-only exposure to exact ancestors.
    ...[...ancestorRoots].map((entry) => `(allow file-read-data (require-all (literal "${sandboxLiteral(entry)}") (vnode-type DIRECTORY)))`),
    // macOS exposes /etc and /var as lexical symlinks to canonical roots.
    // Allow only the symlink objects for path-resolution compatibility.
    '(allow file-read* (literal "/etc"))',
    '(allow file-read* (literal "/var"))',
    ...runtimeAliases.map((entry) => `(allow file-read* (literal "${sandboxLiteral(entry)}"))`),
    ...readableRoots.map((entry) => `(allow file-read* (${lstatSync(entry).isDirectory() ? "subpath" : "literal"} "${sandboxLiteral(entry)}"))`),
    ...modelRoots.map((entry) => `(allow file-read* file-write* (subpath "${sandboxLiteral(entry)}"))`),
    `(allow file-read* file-write* (subpath "${sandboxLiteral(temporary)}"))`,
    ...writableRuntimeRoots.map((entry) => `(allow file-read* file-write* (subpath "${sandboxLiteral(entry)}"))`),
    ...["/dev/null", "/dev/random", "/dev/urandom"].filter(existsSync).map((entry) => `(allow file-read* file-write* (literal "${entry}"))`),
    `(deny file-read* file-write* (subpath "${sandboxLiteral(credentials)}"))`,
    `(deny file-read* file-write* (regex #"^${sandboxRegex(project)}/(.*/)?[.]env[^/]*(/.*)?$"))`,
  ].join("\n");
  if (Buffer.byteLength(profile) > 16 * 1024) throw new Error("Reasoning sandbox profile is too large");
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, commandPath, ...args], env: { TMPDIR: temporary } };
}

export async function readRequest(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BYTES) throw new Error("Work request is too large");
    chunks.push(bytes);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !request ||
    typeof request.text !== "string" ||
    typeof request.senderId !== "string"
  ) {
    throw new Error("Work request is invalid");
  }
  return request;
}

export function invoke(command, args, { input, sandbox = sandboxCommand, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const sandboxed = sandbox(command, args, env);
    const child = spawn(sandboxed.command, sandboxed.args, {
      shell: false,
      detached: false,
      cwd: typeof env.TRIANGLE_INSTANCE_TEMP_ROOT === "string" && path.isAbsolute(env.TRIANGLE_INSTANCE_TEMP_ROOT)
        ? env.TRIANGLE_INSTANCE_TEMP_ROOT
        : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...createRunnerEnvironment(env), ...sandboxed.env },
    });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.byteLength;
      if (outBytes > MAX_BYTES) child.kill("SIGKILL");
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.byteLength;
      if (errBytes <= MAX_BYTES) stderr.push(Buffer.from(chunk));
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (outBytes > MAX_BYTES) {
        reject(new Error("Agent output is too large"));
        return;
      }
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`Agent CLI exited with ${signal ?? code}${errorText ? `: ${errorText.slice(-500)}` : ""}`));
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8").trim();
      if (!text) {
        reject(new Error("Agent CLI returned an empty reply"));
        return;
      }
      resolve(text);
    });
    child.stdin.end(input);
  });
}

export function writeResult(text, stream = process.stdout) {
  stream.write(`${JSON.stringify({ status: "completed", text })}\n`);
}
