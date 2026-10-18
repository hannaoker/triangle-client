/**
 * CURSOR_DATA_DIR isolation + Cursor socket-path preflight.
 *
 * Path semantics mirror cursor-agent 2026.09.10-fd3934a
 * (`../cursor-config/dist/paths.js` in the bundled index.js):
 *   configDir = CURSOR_CONFIG_DIR -> $XDG_CONFIG_HOME/cursor -> ~/.cursor
 *   dataDir   = CURSOR_DATA_DIR -> ~/.cursor
 *   socket    = kL(workspace)/worker.sock, kL base = <dataDir>/projects (<=84)
 *               -> <dataDir> (<=84) -> /tmp/.cursor; >92 => 84 chars + -sha7
 * Everything here runs against temp HOMEs only; nothing reads or writes the
 * real ~/.cursor or a live Triangle profile.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCursorAcpProcess } from "../../src/cursor-acp-runtime/acp-process.mjs";
import { createDefaultCursorAcpShadowProfile } from "../../src/cursor-acp-runtime/config-guards.mjs";
import { createHeadlessCursorAcpRuntime } from "../../src/cursor-acp-runtime/headless-runtime.mjs";
import {
  applyLegacyCursorTranscriptCopy,
  assertCursorSocketPathsFit,
  CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST,
  buildSanitizedCursorChildEnv,
  CURSOR_DATA_DIR_MAX_CHARS,
  cursorWorkspaceSlug,
  defaultTriangleCursorDataDir,
  describeTriangleCursorDirs,
  planCursorSocketPaths,
  planLegacyCursorTranscriptCopy,
  resolveTriangleCursorDataDir,
  resolveTriangleCursorHome,
  revertLegacyCursorTranscriptCopy,
} from "../../src/cursor-acp-runtime/runtime-home.mjs";

function shortTmpRoot() {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(shortTmpRoot(), "tcz-")));
  const cursorHome = resolveTriangleCursorHome({
    override: path.join(home, "ch"),
    home,
    allowCreate: true,
  });
  return { home, cursorHome, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// Production layout for a typical macOS user; pure string math, no fs access.
const PROD_HOME = "/Users/zhenyuhou";
const PROD_CURSOR_HOME = path.join(
  PROD_HOME,
  "Library",
  "Application Support",
  "The Triangle",
  "model-state",
  "cursor-acp-runtime-home",
);

test("child env pins CURSOR_DATA_DIR to ~/.triangle/cursor-data by default", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin", CURSOR_DATA_DIR: path.join(home, ".cursor") },
    });
    const expected = path.join(home, ".triangle", "cursor-data");
    assert.equal(defaultTriangleCursorDataDir({ home }), expected);
    assert.equal(child.CURSOR_DATA_DIR, expected);
    assert.equal(child.TRIANGLE_CURSOR_DATA_DIR, expected);
    assert.equal(child.CURSOR_CONFIG_DIR, cursorHome);
    assert.notEqual(child.CURSOR_DATA_DIR, cursorHome);
    assert.notEqual(child.CURSOR_DATA_DIR, path.join(home, ".cursor"));
  } finally {
    cleanup();
  }
});

test("TRIANGLE_CURSOR_DATA_DIR selects a separate Triangle-owned data dir", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const dataDir = path.join(home, "cd");
    mkdirSync(dataDir);
    const viaEnv = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin", TRIANGLE_CURSOR_DATA_DIR: dataDir },
    });
    assert.equal(viaEnv.CURSOR_DATA_DIR, dataDir);
    assert.equal(viaEnv.CURSOR_CONFIG_DIR, cursorHome);
    const viaArg = buildSanitizedCursorChildEnv({
      cursorHome,
      cursorDataDir: dataDir,
      parentEnv: { HOME: home, PATH: "/usr/bin" },
    });
    assert.equal(viaArg.CURSOR_DATA_DIR, dataDir);
  } finally {
    cleanup();
  }
});

test("extra cannot redirect CURSOR_DATA_DIR away from the Triangle data dir", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    assert.throws(
      () =>
        buildSanitizedCursorChildEnv({
          cursorHome,
          parentEnv: { HOME: home, PATH: "/usr/bin" },
          extra: { CURSOR_DATA_DIR: path.join(home, ".cursor") },
        }),
      { code: "cursor_data_dir_conflict" },
    );
    const defaultDir = path.join(home, ".triangle", "cursor-data");
    const same = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin" },
      extra: { CURSOR_DATA_DIR: defaultDir },
    });
    assert.equal(same.CURSOR_DATA_DIR, defaultDir);
    assert.throws(
      () =>
        buildSanitizedCursorChildEnv({
          cursorHome,
          parentEnv: { HOME: home, PATH: "/usr/bin" },
          extra: { CURSOR_DATA_DIR: cursorHome },
        }),
      { code: "cursor_data_dir_conflict" },
    );
  } finally {
    cleanup();
  }
});

test("data dir may not be ~/.cursor, inside it, ~/.codex, /tmp/.cursor, or relative", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const cases = [
      [path.join(home, ".cursor"), "cursor_data_dir_user_fallback_forbidden"],
      [path.join(home, ".cursor", "projects"), "cursor_data_dir_user_fallback_forbidden"],
      [path.join(home, ".codex"), "cursor_data_dir_codex_forbidden"],
      ["/tmp/.cursor", "cursor_data_dir_shared_forbidden"],
      ["relative/dir", "cursor_data_dir_invalid"],
      [path.join(home, "mesh_watch_ABCDEFGH12345678"), "secret_leak_rejected"],
    ];
    for (const [override, code] of cases) {
      assert.throws(
        () => resolveTriangleCursorDataDir({ override, home }),
        { code },
        override,
      );
    }
    // A symlink that lands inside ~/.cursor is caught after realpath.
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    symlinkSync(path.join(home, ".cursor"), path.join(home, "sneaky"));
    assert.throws(
      () => resolveTriangleCursorDataDir({ override: path.join(home, "sneaky"), home }),
      { code: "cursor_data_dir_user_fallback_forbidden" },
    );
  } finally {
    cleanup();
  }
});

test("socket plan mirrors Cursor kL(): projects base, slug, 92-char hash truncation", () => {
  const dataDir = "/tmp/tcd-abc123";
  const workspace = "/Users/someone/Projects/The Triangle/worktrees/l1a2-cursor-data-dir-socket";
  const plan = planCursorSocketPaths({ dataDir, workspacePaths: [workspace], platform: "darwin" });
  assert.equal(plan.ok, true);
  assert.equal(plan.base.kind, "projects");
  assert.equal(plan.base.dir, "/tmp/tcd-abc123/projects");
  const slug = cursorWorkspaceSlug(workspace);
  assert.equal(slug, "Users-someone-Projects-The-Triangle-worktrees-l1a2-cursor-data-dir-socket");
  const joined = path.join(plan.base.dir, slug);
  assert.ok(joined.length > 92);
  const expectedDir = `${joined.substring(0, 84)}-${createHash("sha256").update(joined).digest("hex").substring(0, 7)}`;
  assert.equal(plan.sockets[0].socketPath, `${expectedDir}/worker.sock`);
  // Cursor caps the socket dir at 92 chars, so worker.sock is at most 104.
  assert.equal(plan.sockets[0].bytes, 104);

  const short = planCursorSocketPaths({ dataDir, workspacePaths: ["/w"], platform: "darwin" });
  assert.equal(short.sockets[0].socketPath, "/tmp/tcd-abc123/projects/w/worker.sock");
});

test("socket base boundary: data dir of 75 chars fits, 76 falls out of projects/", () => {
  const fits = `/${"a".repeat(CURSOR_DATA_DIR_MAX_CHARS - 1)}`;
  const over = `/${"a".repeat(CURSOR_DATA_DIR_MAX_CHARS)}`;
  assert.equal(fits.length, 75);
  assert.equal(planCursorSocketPaths({ dataDir: fits }).ok, true);
  const plan = planCursorSocketPaths({ dataDir: over });
  assert.equal(plan.ok, false);
  assert.equal(plan.base.kind, "data_dir");
  assert.equal(plan.problems[0].reason, "cursor_projects_dir_exceeds_socket_base");
});

test("production-shaped Triangle Cursor home fails preflight with code and suggestion", () => {
  assert.ok(PROD_CURSOR_HOME.length > 84);
  const plan = planCursorSocketPaths({ dataDir: PROD_CURSOR_HOME });
  assert.equal(plan.base.kind, "shared_tmp_fallback");
  assert.equal(plan.base.dir, "/tmp/.cursor");
  assert.throws(
    () => assertCursorSocketPathsFit({ dataDir: PROD_CURSOR_HOME, workspacePaths: [PROD_HOME] }),
    (error) => {
      assert.equal(error.code, "cursor_socket_path_too_long");
      assert.equal(error.reason, "cursor_socket_dir_escapes_to_shared_tmp");
      assert.match(error.message, /TRIANGLE_CURSOR_DATA_DIR/);
      assert.match(error.suggestion, /<= 75 chars/);
      return true;
    },
  );
  // A short Triangle-owned data dir next to it passes.
  const ok = assertCursorSocketPathsFit({
    dataDir: path.join(PROD_HOME, ".triangle", "cursor-data"),
    workspacePaths: [PROD_HOME, path.join(PROD_HOME, "Projects", "The Triangle", "triangle-client")],
  });
  assert.equal(ok.base.kind, "projects");
});

test("multi-byte paths are measured in bytes against the kernel limit", () => {
  const dataDir = `/tmp/${"é".repeat(40)}`;
  assert.ok(path.join(dataDir, "projects").length <= 84);
  const plan = planCursorSocketPaths({
    dataDir,
    workspacePaths: ["/Users/someone/a/very/long/workspace/path/that/forces/truncation"],
    platform: "darwin",
  });
  const reasons = plan.problems.map((problem) => problem.reason);
  assert.ok(reasons.includes("cursor_projects_dir_exceeds_socket_base_bytes"));
  assert.ok(reasons.includes("cursor_socket_path_exceeds_os_limit"));
  assert.throws(() => assertCursorSocketPathsFit({ dataDir }), { code: "cursor_socket_path_too_long" });
});

test("child env build fails closed for a long data dir before anything is spawned", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const longDir = path.join(home, "x".repeat(80));
    let spawned = 0;
    assert.throws(
      () =>
        createCursorAcpProcess({
          command: "agent",
          args: ["acp"],
          cursorHome,
          cursorDataDir: longDir,
          env: { HOME: home, PATH: "/usr/bin" },
          spawnImpl: () => {
            spawned += 1;
            throw new Error("must not spawn");
          },
        }),
      { code: "cursor_socket_path_too_long" },
    );
    assert.throws(
      () =>
        buildSanitizedCursorChildEnv({
          cursorHome,
          parentEnv: { HOME: home, PATH: "/usr/bin", TRIANGLE_CURSOR_DATA_DIR: longDir },
        }),
      { code: "cursor_socket_path_too_long" },
    );
    assert.equal(spawned, 0);
  } finally {
    cleanup();
  }
});

/**
 * Stand-in for `agent acp` that resolves its config/data roots exactly like
 * cursor-agent 2026.09.10-fd3934a and binds the per-workspace worker socket
 * where Cursor would. Sessions live in <configDir>/acp-sessions/<id>/meta.json
 * (as in the real CLI); the transcript lives under
 * <dataDir>/projects/<slug>/agent-transcripts/<id>.jsonl (modelled on the real
 * CLI's transcript location; the exact file format is not Cursor's).
 */
const CURSOR_PATHS_FAKE = String.raw`
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const env = process.env;
const configDir = env.CURSOR_CONFIG_DIR?.trim()
  ? env.CURSOR_CONFIG_DIR
  : env.XDG_CONFIG_HOME?.trim() ? path.join(env.XDG_CONFIG_HOME, "cursor") : path.join(os.homedir(), ".cursor");
const dataDir = env.CURSOR_DATA_DIR?.trim() ? env.CURSOR_DATA_DIR : path.join(os.homedir(), ".cursor");
const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
function socketPathFor(ws) {
  let t = path.join(dataDir, "projects");
  if (t.length > 84) { t = dataDir; if (t.length > 84) t = "/tmp/.cursor"; }
  let n = path.join(t, slug(ws));
  if (n.length > 92) {
    const h = createHash("sha256").update(n).digest("hex").substring(0, 7);
    n = n.substring(0, Math.min(84, n.length)) + "-" + h;
  }
  return path.join(n, "worker.sock");
}
const servers = new Map();
function ensureWorker(ws) {
  const socketPath = socketPathFor(ws);
  if (servers.has(socketPath)) return Promise.resolve(socketPath);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const server = net.createServer((c) => c.end());
    server.once("error", reject);
    server.listen(socketPath, () => { servers.set(socketPath, server); resolve(socketPath); });
  });
}
const sessionDir = (id) => path.join(configDir, "acp-sessions", id);
const transcriptPath = (ws, id) => path.join(dataDir, "projects", slug(ws), "agent-transcripts", id + ".jsonl");
const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const chunk = (sessionId, text) => write({ jsonrpc: "2.0", method: "session/update",
  params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
function shutdown() { for (const s of servers.values()) s.close(); servers.clear(); setTimeout(() => process.exit(0), 10); }
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const { id, method, params = {} } = msg;
  const fail = (message) => write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  try {
    if (method === "initialize") {
      return write({ jsonrpc: "2.0", id, result: { protocolVersion: 1,
        agentCapabilities: { loadSession: true }, authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
        _meta: { configDir, dataDir } } });
    }
    if (method === "authenticate") return write({ jsonrpc: "2.0", id, result: {} });
    if (method === "session/new") {
      const sessionId = randomUUID();
      const socketPath = await ensureWorker(params.cwd);
      fs.mkdirSync(sessionDir(sessionId), { recursive: true });
      fs.writeFileSync(path.join(sessionDir(sessionId), "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: params.cwd }));
      fs.mkdirSync(path.dirname(transcriptPath(params.cwd, sessionId)), { recursive: true });
      fs.writeFileSync(transcriptPath(params.cwd, sessionId), "");
      return write({ jsonrpc: "2.0", id, result: { sessionId, _meta: { socketPath } } });
    }
    if (method === "session/load") {
      const metaPath = path.join(sessionDir(params.sessionId), "meta.json");
      if (!fs.existsSync(metaPath)) return fail("session not found: " + params.sessionId);
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const socketPath = await ensureWorker(params.cwd ?? meta.cwd);
      const tp = transcriptPath(meta.cwd, params.sessionId);
      const lines = fs.existsSync(tp) ? fs.readFileSync(tp, "utf8").split("\n").filter(Boolean) : [];
      for (const l of lines) chunk(params.sessionId, JSON.parse(l).text);
      return write({ jsonrpc: "2.0", id, result: { sessionId: params.sessionId, _meta: { socketPath, replayed: lines.length } } });
    }
    if (method === "session/prompt") {
      const metaPath = path.join(sessionDir(params.sessionId), "meta.json");
      if (!fs.existsSync(metaPath)) return fail("session not found");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const text = (params.prompt ?? []).map((p) => p.text ?? "").join("");
      const reply = "echo:" + text;
      fs.appendFileSync(transcriptPath(meta.cwd, params.sessionId),
        JSON.stringify({ role: "user", text }) + "\n" + JSON.stringify({ role: "assistant", text: reply }) + "\n");
      chunk(params.sessionId, reply);
      return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    fail("unsupported " + method);
  } catch (error) {
    fail(String(error?.message ?? error));
  }
});
`;

function writeCursorPathsFake(dir) {
  const file = path.join(dir, "fake-cursor-agent.mjs");
  writeFileSync(file, CURSOR_PATHS_FAKE, { mode: 0o600 });
  return { command: process.execPath, args: [file] };
}

const liveHandles = new Set();
function track(handle) {
  liveHandles.add(handle);
  return handle;
}
async function closeTracked() {
  for (const handle of liveHandles) await handle.close().catch(() => {});
  liveHandles.clear();
}

function listTree(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).map(String).sort();
}

test("restart + session/load resume entirely inside the isolated config/data dirs (temp HOME)", async () => {
  const { home, cursorHome, cleanup } = fixture();
  const toolDir = realpathSync(mkdtempSync(path.join(shortTmpRoot(), "tcf-")));
  try {
    const fake = writeCursorPathsFake(toolDir);
    const workspace = path.join(home, "ws");
    mkdirSync(workspace);
    // A legacy session that only exists in the (temp) user ~/.cursor.
    const legacyId = "97a0e930-e06e-4c34-94dc-bbf960f8a8e4";
    mkdirSync(path.join(home, ".cursor", "acp-sessions", legacyId), { recursive: true });
    writeFileSync(path.join(home, ".cursor", "acp-sessions", legacyId, "meta.json"), JSON.stringify({ cwd: workspace }));
    const userCursorBefore = listTree(path.join(home, ".cursor"));

    const env = {
      HOME: home,
      PATH: process.env.PATH,
      // Parent-level overrides must not leak through to the child.
      CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
      CURSOR_DATA_DIR: path.join(home, ".cursor"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
    };

    const dataDir = path.join(home, ".triangle", "cursor-data");
    const first = track(createCursorAcpProcess({ command: fake.command, args: fake.args, cursorHome, env }));
    await first.start();
    const init = await first.initialize();
    assert.deepEqual(init._meta, { configDir: cursorHome, dataDir });
    await first.authenticate();
    const created = await first.sessionNew({ cwd: workspace });
    const plan = planCursorSocketPaths({ dataDir, workspacePaths: [workspace] });
    assert.equal(created._meta.socketPath, plan.sockets[0].socketPath);
    assert.ok(created._meta.socketPath.startsWith(path.join(dataDir, "projects") + path.sep));
    const turn = await first.sessionPrompt({ sessionId: created.sessionId, text: "remember TOKEN_R1" });
    assert.equal(turn.assistantText, "echo:remember TOKEN_R1");
    await first.close();
    assert.equal(existsSync(created._meta.socketPath), false, "worker socket removed on shutdown");

    // Restart: a brand-new child resumes from the isolated dirs.
    const second = track(createCursorAcpProcess({ command: fake.command, args: fake.args, cursorHome, env }));
    await second.ensureReady();
    const replayed = [];
    const off = second.onEvent((event) => {
      if (event.method === "session/update") replayed.push(event.params.update.content.text);
    });
    const loaded = await second.sessionLoad({ sessionId: created.sessionId, cwd: workspace });
    off();
    assert.equal(loaded._meta.replayed, 2);
    assert.deepEqual(replayed, ["remember TOKEN_R1", "echo:remember TOKEN_R1"]);
    assert.equal(loaded._meta.socketPath, created._meta.socketPath);
    // The legacy ~/.cursor session is invisible to the isolated child.
    await assert.rejects(second.sessionLoad({ sessionId: legacyId, cwd: workspace }), { code: "rpc_error" });
    await second.close();

    assert.ok(existsSync(path.join(cursorHome, "acp-sessions", created.sessionId, "meta.json")));
    assert.ok(
      existsSync(
        path.join(dataDir, "projects", cursorWorkspaceSlug(workspace), "agent-transcripts", `${created.sessionId}.jsonl`),
      ),
    );
    assert.equal(existsSync(path.join(cursorHome, "projects")), false);
    assert.deepEqual(listTree(path.join(home, ".cursor")), userCursorBefore, "temp ~/.cursor untouched");
    assert.equal(existsSync(path.join(home, ".config", "cursor")), false);
  } finally {
    await closeTracked();
    cleanup();
    rmSync(toolDir, { recursive: true, force: true });
  }
});

test("restart with a separate TRIANGLE_CURSOR_DATA_DIR keeps sessions in config dir and data in data dir", async () => {
  const { home, cursorHome, cleanup } = fixture();
  const toolDir = realpathSync(mkdtempSync(path.join(shortTmpRoot(), "tcf-")));
  try {
    const fake = writeCursorPathsFake(toolDir);
    const dataDir = path.join(home, "cd");
    const workspace = path.join(home, "ws");
    mkdirSync(workspace);
    const env = { HOME: home, PATH: process.env.PATH, TRIANGLE_CURSOR_DATA_DIR: dataDir };

    const first = track(createCursorAcpProcess({ command: fake.command, args: fake.args, cursorHome, env }));
    assert.equal(first.status().cursorDataDir, realpathSync(dataDir));
    assert.equal(first.status().cursorDataDirSource, "override");
    await first.ensureReady();
    const created = await first.sessionNew({ cwd: workspace });
    await first.sessionPrompt({ sessionId: created.sessionId, text: "TOKEN_R2" });
    await first.close();

    const second = track(createCursorAcpProcess({ command: fake.command, args: fake.args, cursorHome, env }));
    await second.ensureReady();
    const loaded = await second.sessionLoad({ sessionId: created.sessionId, cwd: workspace });
    assert.equal(loaded._meta.replayed, 2);
    assert.ok(loaded._meta.socketPath.startsWith(path.join(realpathSync(dataDir), "projects") + path.sep));
    await second.close();

    assert.ok(existsSync(path.join(cursorHome, "acp-sessions", created.sessionId)));
    assert.equal(existsSync(path.join(dataDir, "acp-sessions")), false);
    assert.equal(existsSync(path.join(cursorHome, "projects")), false);
    assert.equal(existsSync(path.join(home, ".cursor")), false);
    assert.equal(existsSync(path.join(home, ".triangle")), false);
  } finally {
    await closeTracked();
    cleanup();
    rmSync(toolDir, { recursive: true, force: true });
  }
});

test("real-length default data dir on this machine's HOME passes the socket preflight", () => {
  // Pure path math against the real HOME (no fs access to it).
  for (const home of [homedir(), PROD_HOME]) {
    const dataDir = defaultTriangleCursorDataDir({ home });
    assert.ok(dataDir.length <= CURSOR_DATA_DIR_MAX_CHARS, `${dataDir} (${dataDir.length})`);
    const plan = assertCursorSocketPathsFit({
      dataDir,
      workspacePaths: [
        home,
        path.join(home, "Projects", "The Triangle", "triangle-client"),
        path.join(home, "Projects", "The Triangle", "worktrees", "l1a2-cursor-data-dir", "deeply", "nested", "workspace"),
      ],
    });
    assert.equal(plan.base.kind, "projects");
    assert.equal(plan.base.dir, path.join(home, ".triangle", "cursor-data", "projects"));
  }
  // /Users/zhenyuhou/.triangle/cursor-data/projects = 47 chars (limit 84).
  assert.equal(path.join(defaultTriangleCursorDataDir({ home: PROD_HOME }), "projects").length, 47);
  // The long Cursor home itself would still fail if forced as the data dir.
  assert.throws(() => assertCursorSocketPathsFit({ dataDir: PROD_CURSOR_HOME }), {
    code: "cursor_socket_path_too_long",
  });
});

test("process creates the default data dir 0700 on first use and reports it in status", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const expected = path.join(home, ".triangle", "cursor-data");
    assert.equal(existsSync(expected), false);
    const handle = createCursorAcpProcess({
      command: "agent",
      args: ["acp"],
      cursorHome,
      env: { HOME: home, PATH: "/usr/bin" },
      spawnImpl: () => {
        throw new Error("not spawned in this test");
      },
    });
    assert.equal(statSync(expected).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(home, ".triangle")).mode & 0o777, 0o700);
    assert.equal(handle.status().cursorDataDir, expected);
    assert.equal(handle.status().cursorDataDirSource, "default");
    assert.equal(handle.status().cursorHome, cursorHome);
  } finally {
    cleanup();
  }
});

test("headless runtime status and describeTriangleCursorDirs report the chosen dirs", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const runtime = createHeadlessCursorAcpRuntime({
      profileConfig: createDefaultCursorAcpShadowProfile({
        workingDirectory: path.join(home, "cwd"),
        workload: "conversational",
        model: "composer-2.5[fast=true]",
      }),
      enableShadow: true,
      command: "agent",
      args: ["acp"],
      cursorHome,
      env: { HOME: home, PATH: "/usr/bin" },
      logger: { info() {}, error() {} },
    });
    assert.equal(runtime.active, true);
    const dirs = runtime.status().cursorDirs;
    assert.equal(dirs.configDir, cursorHome);
    assert.equal(dirs.dataDir, path.join(home, ".triangle", "cursor-data"));
    assert.equal(dirs.dataDirSource, "default");
    assert.equal(dirs.socketPreflight.ok, true);
    assert.equal(dirs.socketPreflight.base, "projects");

    const bad = describeTriangleCursorDirs({
      cursorHome,
      env: { HOME: home, TRIANGLE_CURSOR_DATA_DIR: path.join(home, "y".repeat(90)) },
    });
    assert.equal(bad.dataDirSource, "override");
    assert.equal(bad.socketPreflight.ok, false);
    assert.deepEqual([...bad.socketPreflight.reasons], ["cursor_socket_dir_escapes_to_shared_tmp"]);
    const invalid = describeTriangleCursorDirs({
      cursorHome,
      env: { HOME: home, TRIANGLE_CURSOR_DATA_DIR: path.join(home, ".cursor") },
    });
    assert.equal(invalid.dataDirError, "cursor_data_dir_user_fallback_forbidden");
  } finally {
    cleanup();
  }
});

// ---- legacy transcript copy (temp HOME only) ----

function seedLegacyTranscripts(home, workspace) {
  const projectDir = path.join(home, ".cursor", "projects", cursorWorkspaceSlug(workspace));
  const transcripts = path.join(projectDir, "agent-transcripts");
  mkdirSync(path.join(transcripts, "nested"), { recursive: true });
  writeFileSync(path.join(transcripts, "a.jsonl"), "line-a\n");
  writeFileSync(path.join(transcripts, "b.txt"), "line-b\n");
  writeFileSync(path.join(transcripts, "nested", "c.jsonl"), "line-c\n");
  // Non-transcript siblings that must never be copied.
  writeFileSync(path.join(projectDir, "worker.log"), "log\n");
  mkdirSync(path.join(projectDir, "terminals"), { recursive: true });
  writeFileSync(path.join(projectDir, "terminals", "1.txt"), "term\n");
  return { projectDir, transcripts };
}

function snapshotTree(root) {
  return listTree(root).map((relative) => {
    const absolute = path.join(root, relative);
    const stat = statSync(absolute);
    return [relative, stat.isFile() ? readFileSync(absolute, "utf8") : "<dir>", stat.mtimeMs];
  });
}

test("legacy transcript copy: plan is read-only, apply copies, revert removes only what apply created", () => {
  const { home, cleanup } = fixture();
  try {
    const workspace = path.join(home, "ws");
    const other = path.join(home, "never-used");
    const { transcripts } = seedLegacyTranscripts(home, workspace);
    symlinkSync(path.join(transcripts, "a.jsonl"), path.join(transcripts, "link.jsonl"));
    const userCursorBefore = snapshotTree(path.join(home, ".cursor"));
    const dataDir = path.join(home, ".triangle", "cursor-data");
    const slug = cursorWorkspaceSlug(workspace);
    const targetTranscripts = path.join(dataDir, "projects", slug, "agent-transcripts");

    // Pre-existing isolated transcript must win and survive revert.
    mkdirSync(targetTranscripts, { recursive: true });
    writeFileSync(path.join(targetTranscripts, "b.txt"), "isolated-b\n");

    const plan = planLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace, other] });
    assert.equal(plan.dataDir, dataDir);
    const ws = plan.workspaces.find((entry) => entry.slug === slug);
    assert.equal(ws.action, "copy");
    assert.deepEqual(
      ws.files.map((entry) => [entry.relative, entry.action]),
      [
        ["a.jsonl", "copy"],
        ["b.txt", "already_present"],
        [path.join("nested", "c.jsonl"), "copy"],
        ["link.jsonl", "unsafe_source"],
      ],
    );
    assert.equal(plan.workspaces.find((entry) => entry.workspacePath === other).action, "missing_source");
    assert.deepEqual(snapshotTree(path.join(home, ".cursor")), userCursorBefore, "plan is read-only (source)");
    assert.deepEqual(listTree(targetTranscripts), ["b.txt"], "plan is read-only (target)");

    const applied = applyLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace, other] });
    assert.deepEqual([...applied.copied].sort(), [
      `projects/${slug}/agent-transcripts/a.jsonl`,
      `projects/${slug}/agent-transcripts/nested/c.jsonl`,
    ]);
    assert.equal(readFileSync(path.join(targetTranscripts, "a.jsonl"), "utf8"), "line-a\n");
    assert.equal(readFileSync(path.join(targetTranscripts, "nested", "c.jsonl"), "utf8"), "line-c\n");
    assert.equal(readFileSync(path.join(targetTranscripts, "b.txt"), "utf8"), "isolated-b\n");
    assert.equal(existsSync(path.join(targetTranscripts, "link.jsonl")), false);
    assert.equal(existsSync(path.join(dataDir, "projects", slug, "worker.log")), false);
    assert.equal(existsSync(path.join(dataDir, "projects", slug, "terminals")), false);
    assert.ok(
      Math.abs(
        statSync(path.join(targetTranscripts, "a.jsonl")).mtimeMs - statSync(path.join(transcripts, "a.jsonl")).mtimeMs,
      ) < 1,
      "mtime preserved (sub-ms precision)",
    );
    assert.deepEqual(snapshotTree(path.join(home, ".cursor")), userCursorBefore, "apply never touches the source");
    assert.ok(existsSync(path.join(dataDir, "projects", CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST)));

    // Idempotent: a second apply copies nothing.
    const again = applyLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
    assert.deepEqual([...again.copied], []);

    // A file Cursor writes after apply must survive revert (and keep its dir).
    writeFileSync(path.join(targetTranscripts, "nested", "new-after-apply.jsonl"), "new\n");

    const reverted = revertLegacyCursorTranscriptCopy({ home });
    assert.equal(reverted.removedFiles.length, 2);
    assert.deepEqual([...reverted.keptDirs], [`projects/${slug}/agent-transcripts/nested`]);
    assert.deepEqual([...reverted.keptFiles], []);
    assert.deepEqual(listTree(targetTranscripts).sort(), ["b.txt", "nested", path.join("nested", "new-after-apply.jsonl")]);
    assert.equal(readFileSync(path.join(targetTranscripts, "b.txt"), "utf8"), "isolated-b\n");
    // The non-empty "nested" dir stays recorded, so the manifest is kept.
    assert.equal(existsSync(path.join(dataDir, "projects", CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST)), true);
    assert.deepEqual(snapshotTree(path.join(home, ".cursor")), userCursorBefore, "revert never touches the source");
  } finally {
    cleanup();
  }
});

test("legacy transcript copy into a fresh data dir: revert removes the dirs apply created", () => {
  const { home, cleanup } = fixture();
  try {
    const workspace = path.join(home, "ws2");
    seedLegacyTranscripts(home, workspace);
    const dataDir = path.join(home, "cd");
    mkdirSync(dataDir);
    applyLegacyCursorTranscriptCopy({ home, cursorDataDir: dataDir, workspacePaths: [workspace] });
    assert.equal(listTree(path.join(dataDir, "projects")).filter((entry) => entry.endsWith(".jsonl") || entry.endsWith(".txt")).length, 3);
    const reverted = revertLegacyCursorTranscriptCopy({ home, cursorDataDir: dataDir });
    assert.equal(reverted.removedFiles.length, 3);
    assert.deepEqual([...reverted.keptDirs], []);
    assert.deepEqual(listTree(path.join(dataDir, "projects")), []);
  } finally {
    cleanup();
  }
});

test("legacy transcript copy rejects bad inputs and tampered manifests", () => {
  const { home, cleanup } = fixture();
  try {
    assert.throws(() => planLegacyCursorTranscriptCopy({ home, workspacePaths: [] }), { code: "cursor_workspace_invalid" });
    assert.throws(() => planLegacyCursorTranscriptCopy({ home, workspacePaths: ["rel/ws"] }), {
      code: "cursor_workspace_invalid",
    });
    assert.throws(() => planLegacyCursorTranscriptCopy({ home, workspacePaths: ["/"] }), {
      code: "cursor_workspace_invalid",
    });
    assert.throws(
      () => planLegacyCursorTranscriptCopy({ home, cursorDataDir: path.join(home, ".cursor"), workspacePaths: ["/w"] }),
      { code: "cursor_data_dir_user_fallback_forbidden" },
    );
    // Source dir that is a symlink is refused.
    const workspace = path.join(home, "ws3");
    const projectDir = path.join(home, ".cursor", "projects", cursorWorkspaceSlug(workspace));
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(path.join(home, "elsewhere"));
    symlinkSync(path.join(home, "elsewhere"), path.join(projectDir, "agent-transcripts"));
    const plan = planLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
    assert.equal(plan.workspaces[0].action, "unsafe_source");

    const projectsRoot = path.join(home, ".triangle", "cursor-data", "projects");
    mkdirSync(projectsRoot, { recursive: true });
    writeFileSync(path.join(home, "victim.txt"), "keep");
    const victimStat = statSync(path.join(home, "victim.txt"));
    const victimIdentity = {
      size: victimStat.size,
      mtimeMs: victimStat.mtimeMs,
      sha256: createHash("sha256").update("keep").digest("hex"),
    };
    const manifestPath = path.join(projectsRoot, CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        createdFiles: [
          { path: "../../victim.txt", ...victimIdentity },
          { path: path.join(home, "victim.txt"), ...victimIdentity },
          { path: "projects/ws-x/agent-transcripts/no-snapshot.txt" },
        ],
        createdDirs: ["../.."],
      }),
    );
    mkdirSync(path.join(projectsRoot, "ws-x", "agent-transcripts"), { recursive: true });
    writeFileSync(path.join(projectsRoot, "ws-x", "agent-transcripts", "no-snapshot.txt"), "v1 entry");
    const reverted = revertLegacyCursorTranscriptCopy({ home });
    assert.deepEqual(reverted.removedFiles, []);
    assert.deepEqual(
      reverted.keptFiles.map((file) => file.reason),
      ["unsafe_path", "unsafe_path", "no_snapshot"],
    );
    assert.equal(readFileSync(path.join(home, "victim.txt"), "utf8"), "keep");
    assert.ok(existsSync(path.join(projectsRoot, "ws-x", "agent-transcripts", "no-snapshot.txt")));
    assert.ok(existsSync(manifestPath), "manifest preserved on conflict");
  } finally {
    cleanup();
  }
});

test("F2: undo keeps a copied transcript appended after migration and never touches new transcripts", () => {
  const { home, cleanup } = fixture();
  try {
    const workspace = path.join(home, "ws-f2");
    const { transcripts } = seedLegacyTranscripts(home, workspace);
    applyLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
    const slug = cursorWorkspaceSlug(workspace);
    const target = path.join(home, ".triangle", "cursor-data", "projects", slug, "agent-transcripts");
    // Synthetic post-migration work.
    writeFileSync(path.join(target, "a.jsonl"), "line-a\nnew accepted reply\n");
    writeFileSync(path.join(target, "fresh-session.jsonl"), "brand new\n");

    const reverted = revertLegacyCursorTranscriptCopy({ home });
    assert.deepEqual([...reverted.removedFiles].sort(), [
      `projects/${slug}/agent-transcripts/b.txt`,
      `projects/${slug}/agent-transcripts/nested/c.jsonl`,
    ]);
    assert.deepEqual(reverted.keptFiles.map((file) => [file.path, file.reason]), [
      [`projects/${slug}/agent-transcripts/a.jsonl`, "modified_after_migration"],
    ]);
    assert.equal(readFileSync(path.join(target, "a.jsonl"), "utf8"), "line-a\nnew accepted reply\n");
    assert.equal(readFileSync(path.join(target, "fresh-session.jsonl"), "utf8"), "brand new\n");
    assert.equal(existsSync(path.join(target, "nested")), false, "emptied recorded dir removed");
    const manifest = JSON.parse(
      readFileSync(path.join(home, ".triangle", "cursor-data", "projects", CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST), "utf8"),
    );
    assert.deepEqual(manifest.createdFiles.map((file) => file.path), [`projects/${slug}/agent-transcripts/a.jsonl`]);
    assert.equal(manifest.createdFiles[0].lastRevert.reason, "modified_after_migration");
    // Legacy source untouched.
    assert.equal(readFileSync(path.join(transcripts, "a.jsonl"), "utf8"), "line-a\n");
  } finally {
    cleanup();
  }
});

test("F1: a parent replaced by a symlink cannot make undo delete outside the data dir", () => {
  const { home, cleanup } = fixture();
  try {
    const workspace = path.join(home, "ws-f1");
    seedLegacyTranscripts(home, workspace);
    applyLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
    const slug = cursorWorkspaceSlug(workspace);
    const target = path.join(home, ".triangle", "cursor-data", "projects", slug, "agent-transcripts");
    // Outside dir holding byte-identical files with identical mtimes, so only
    // physical containment (not identity) can stop the deletion.
    const outside = path.join(home, "unrelated");
    mkdirSync(path.join(outside, "nested"), { recursive: true });
    for (const name of ["a.jsonl", "b.txt", path.join("nested", "c.jsonl")]) {
      writeFileSync(path.join(outside, name), readFileSync(path.join(target, name)));
      const stat = statSync(path.join(target, name));
      utimesSync(path.join(outside, name), stat.atime, stat.mtime);
    }
    rmSync(target, { recursive: true });
    symlinkSync(outside, target, "dir");

    const reverted = revertLegacyCursorTranscriptCopy({ home });
    assert.deepEqual(reverted.removedFiles, []);
    assert.equal(reverted.keptFiles.length, 3);
    assert.ok(reverted.keptFiles.every((file) => file.reason === "unsafe_path"));
    assert.ok(reverted.keptFiles.every((file) => file.detail === "owned_path_symlink_rejected"));
    for (const name of ["a.jsonl", "b.txt", path.join("nested", "c.jsonl")]) {
      assert.ok(existsSync(path.join(outside, name)), name);
    }
    assert.ok(existsSync(path.join(home, ".triangle", "cursor-data", "projects", CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST)));
  } finally {
    cleanup();
  }
});

test("F1: apply never copies through a symlinked target parent or projects root", () => {
  const { home, cleanup } = fixture();
  try {
    const workspace = path.join(home, "ws-f1b");
    seedLegacyTranscripts(home, workspace);
    const slug = cursorWorkspaceSlug(workspace);
    const projects = path.join(home, ".triangle", "cursor-data", "projects");
    const outside = path.join(home, "outside");
    mkdirSync(outside);
    mkdirSync(path.join(projects, slug), { recursive: true });
    symlinkSync(outside, path.join(projects, slug, "agent-transcripts"), "dir");

    const plan = planLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
    assert.equal(plan.workspaces[0].action, "unsafe_target");
    const applied = applyLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
    assert.deepEqual([...applied.copied], []);
    assert.deepEqual(readdirSync(outside), []);

    // Whole projects root swapped for a symlink: refuse before reading/writing.
    rmSync(projects, { recursive: true });
    symlinkSync(outside, projects, "dir");
    assert.throws(() => applyLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] }), {
      code: "owned_path_symlink_rejected",
    });
    assert.throws(() => revertLegacyCursorTranscriptCopy({ home }), { code: "owned_path_symlink_rejected" });
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    cleanup();
  }
});

test("codex r1: tampered transcript manifest cannot name non-transcript files or dirs, even with matching identity", () => {
  const { home, cleanup } = fixture();
  try {
    const projectsRoot = path.join(home, ".triangle", "cursor-data", "projects");
    const slugDir = path.join(projectsRoot, "ws-y");
    mkdirSync(path.join(slugDir, "unrelated-empty"), { recursive: true });
    const log = path.join(slugDir, "worker.log");
    writeFileSync(log, "live worker log");
    const stat = statSync(log);
    const identity = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update("live worker log").digest("hex"),
    };
    const manifestPath = path.join(projectsRoot, CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        createdFiles: [{ path: "projects/ws-y/worker.log", ...identity }],
        createdDirs: ["projects/ws-y/unrelated-empty", "projects"],
      }),
    );
    const reverted = revertLegacyCursorTranscriptCopy({ home });
    assert.deepEqual(reverted.removedFiles, []);
    assert.deepEqual(reverted.removedDirs, []);
    assert.equal(reverted.keptFiles[0].reason, "unsafe_path");
    assert.equal(reverted.keptFiles[0].detail, "manifest_entry_outside_transcripts");
    assert.deepEqual([...reverted.keptDirs].sort(), ["projects", "projects/ws-y/unrelated-empty"]);
    assert.equal(readFileSync(log, "utf8"), "live worker log");
    assert.ok(existsSync(path.join(slugDir, "unrelated-empty")));
    assert.ok(existsSync(manifestPath));
  } finally {
    cleanup();
  }
});

test("codex r1: transcript plan/apply refuse symlinked legacy source ancestors", () => {
  for (const linked of ["projects", "slug"]) {
    const { home, cleanup } = fixture();
    try {
      const workspace = path.join(home, "ws4");
      const slug = cursorWorkspaceSlug(workspace);
      const outside = path.join(home, "outside-legacy");
      const outsideTranscripts = path.join(outside, ...(linked === "projects" ? [slug] : []), "agent-transcripts");
      mkdirSync(outsideTranscripts, { recursive: true });
      writeFileSync(path.join(outsideTranscripts, "t.jsonl"), "outside transcript");
      mkdirSync(path.join(home, ".cursor", ...(linked === "slug" ? ["projects"] : [])), { recursive: true });
      symlinkSync(
        outside,
        linked === "projects" ? path.join(home, ".cursor", "projects") : path.join(home, ".cursor", "projects", slug),
        "dir",
      );
      const plan = planLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
      assert.equal(plan.workspaces[0].action, "unsafe_source", linked);
      const applied = applyLegacyCursorTranscriptCopy({ home, workspacePaths: [workspace] });
      assert.deepEqual(applied.copied, []);
      assert.equal(
        existsSync(path.join(home, ".triangle", "cursor-data", "projects", slug, "agent-transcripts", "t.jsonl")),
        false,
      );
    } finally {
      cleanup();
    }
  }
});

test("codex r1: data dir below a symlink into ~/.cursor or ~/.codex is rejected before mkdir", () => {
  for (const forbidden of [".cursor", ".codex"]) {
    const { home, cleanup } = fixture();
    try {
      mkdirSync(path.join(home, forbidden));
      symlinkSync(path.join(home, forbidden), path.join(home, "alias"), "dir");
      const override = path.join(home, "alias", "new", "data");
      assert.throws(
        () => resolveTriangleCursorDataDir({ override, home, allowCreate: true }),
        { code: forbidden === ".cursor" ? "cursor_data_dir_user_fallback_forbidden" : "cursor_data_dir_codex_forbidden" },
      );
      assert.deepEqual(readdirSync(path.join(home, forbidden)), [], `nothing created inside ${forbidden}`);
    } finally {
      cleanup();
    }
  }
});
