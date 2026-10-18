// Load one agent's workload credential from triangle custody (permissions v1).
// `agents/<agent_id>/workload-key.json` (private Ed25519 JWK, 0600) and its
// sibling `agent.json` (agent_id, workload_id). Only this agent's key is read;
// the owner key never reaches a worker.
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, constants } from "node:fs";
import path from "node:path";

import { parseWorkloadPrivateKey } from "./mailbox-client.mjs";
import { workloadScopes } from "../../triangle-cli/src/protocol.mjs";

const AGENT_ID = /^agent_[a-f0-9]{32}$/;
const WORKLOAD_ID = /^workload_[a-f0-9]{32}$/;
const MAX_BYTES = 64 * 1024;

// Swift `V1PrivateDirectory.isSafe`: a real directory (lstat, so never a
// symlink) owned by this user with no group/other mode bits (0700-style).
function requirePrivateDirectory(dir, name) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new TypeError(`${name} must be a real directory`);
  if (stat.uid !== process.getuid?.()) throw new TypeError(`${name} is not owned by this user`);
  if ((stat.mode & 0o077) !== 0) throw new TypeError(`${name} must not be accessible by group or others (chmod 700)`);
}

function readPrivateFile(file, name) {
  const link = lstatSync(file, { throwIfNoEntry: false });
  if (!link) throw new TypeError(`${name} does not exist`);
  if (!link.isFile()) throw new TypeError(`${name} must be a regular file`);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid?.()) throw new TypeError(`${name} is not owned by this user`);
    if (stat.nlink !== 1) throw new TypeError(`${name} must not have additional hard links`);
    if ((stat.mode & 0o077) !== 0) throw new TypeError(`${name} must not be readable by group or others (chmod 600)`);
    if (stat.size > MAX_BYTES) throw new TypeError(`${name} is too large`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function loadWorkloadCredential(keyFile, { expectedAgentId } = {}) {
  if (typeof keyFile !== "string" || !path.isAbsolute(keyFile)) {
    throw new TypeError("workload key file must be an absolute path");
  }
  // Same layout and parent checks as the Swift loader (V1AgentCredentialLoader):
  // <home>/agents/<agent_id>/workload-key.json, every custody directory private,
  // so a symlinked or shared parent cannot redirect the key.
  const resolved = path.resolve(keyFile);
  if (resolved !== keyFile || path.basename(keyFile) !== "workload-key.json") {
    throw new TypeError("workload key file must be <home>/agents/<agent_id>/workload-key.json");
  }
  const agentDir = path.dirname(keyFile);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) !== "agents") {
    throw new TypeError("workload key file is not under the custody agents/ directory");
  }
  requirePrivateDirectory(path.dirname(agentsDir), "custody home");
  requirePrivateDirectory(agentsDir, "custody agents/ directory");
  requirePrivateDirectory(agentDir, "agent custody directory");
  const keyText = readPrivateFile(keyFile, "workload key file").trim();
  parseWorkloadPrivateKey(keyText);
  let agent;
  try {
    agent = JSON.parse(readPrivateFile(path.join(path.dirname(keyFile), "agent.json"), "agent.json"));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("agent.json is invalid");
  }
  if (!AGENT_ID.test(agent?.agent_id ?? "") || !WORKLOAD_ID.test(agent?.workload_id ?? "")) {
    throw new TypeError("agent.json is invalid");
  }
  if (path.basename(path.dirname(keyFile)) !== agent.agent_id) {
    throw new TypeError("workload key file is not in its agent's directory");
  }
  if (expectedAgentId !== undefined && expectedAgentId !== agent.agent_id) {
    throw new TypeError("workload key belongs to a different agent");
  }
  // Registered bounds (`agent.json` `bounds`, written by triangle): a
  // read-only agent requests agent.read only, since MESH refuses more.
  let scopes;
  try {
    if (agent.bounds !== undefined && !Array.isArray(agent.bounds)) throw new TypeError("bounds");
    scopes = workloadScopes(agent.bounds, "agent.json bounds");
  }
  catch { throw new TypeError("agent.json bounds are invalid"); }
  return Object.freeze({ agentId: agent.agent_id, workloadId: agent.workload_id, workloadPrivateKey: keyText, workloadScopes: Object.freeze(scopes) });
}
