// `triangle status` / `triangle doctor` (§1.3, §3.6): who this device is, what
// it controls, and what needs attention — without printing any key material.
import { listAgents } from "./agents.mjs";
import { MeshApiError } from "./errors.mjs";

export const TRUST_COPY = [
  "Agents on this computer run as you. Anything an agent runs here could use this computer's owner key, so only run agents you would trust with your account.",
  "This computer is the only key that controls these agents. If you lose it and have not added a second device, nobody (including the server admin) can recover control. You would recreate your agents.",
];

export async function doctor(session) {
  const report = {
    home: session.custody.root,
    authority: session.transport?.authority ?? null,
    transport: session.transport && session.transport.base !== session.transport.authority ? session.transport.base : null,
    device: session.owner ? { controller_id: session.owner.controller_id, label: session.owner.device_label, fingerprint: session.owner.fingerprint, state: session.owner.state } : null,
    owner: null,
    devices: [],
    agents: [],
    pending: session.custody.listJournal(),
    file_mode_problems: session.custody.auditModes(),
    warnings: [],
  };
  if (!session.owner) {
    report.warnings.push("Not joined. Run `triangle join <link>`.");
    return report;
  }
  report.device.state = (await session.refreshController()) ?? report.device.state;
  if (report.device.state !== "active") {
    report.warnings.push(`Waiting for approval: on one of your other devices run \`triangle device approve ${session.owner.fingerprint}\`.`);
    return report;
  }
  try {
    const view = await listAgents(session);
    report.owner = view.owner;
    report.devices = view.controllers.map((c) => ({ controller_id: c.controller_id, label: c.device_label, kind: c.kind, state: c.state, this_device: c.controller_id === view.calling_controller_id }));
    report.agents = view.agents;
    const activeDevices = view.controllers.filter((c) => c.state === "active").length;
    if (activeDevices < 2) report.warnings.push("No backup owner device. If you lose this computer you cannot change your agents' permissions. Add one with `triangle invite device`.");
    for (const agent of view.agents) if (agent.state === "paused") report.warnings.push(`${agent.handle} is paused.`);
    const missing = session.custody.listAgents().filter((local) => !view.agents.some((a) => a.agent_id === local.agent_id));
    for (const agent of missing) report.warnings.push(`${agent.handle} (${agent.agent_id}) has a key here but is not one of your agents on the server (deleted?).`);
  } catch (error) {
    if (!(error instanceof MeshApiError)) throw error;
    report.warnings.push(error.message);
  }
  if (report.pending.length) report.warnings.push(`Unfinished requests: ${report.pending.join(", ")}. Run \`triangle resume\` (or \`triangle join --resume\`).`);
  if (report.file_mode_problems.length) report.warnings.push(`Files readable by others: ${report.file_mode_problems.join(", ")}.`);
  return report;
}

export function renderDoctor(report) {
  const lines = [];
  lines.push(`MESH:      ${report.authority ?? "(not joined)"}${report.transport ? `  via ${report.transport}` : ""}`);
  if (report.device) lines.push(`Device:    ${report.device.label} · ${report.device.fingerprint} · ${report.device.state}`);
  if (report.owner) lines.push(`Owner:     ${report.owner.display_name ?? report.owner.id} (${report.owner.role}, ${report.owner.state})`);
  if (report.devices.length) {
    lines.push("Devices:");
    for (const d of report.devices) lines.push(`  - ${d.label ?? d.kind} · ${d.state}${d.this_device ? " (this device)" : ""}`);
  }
  if (report.agents.length) {
    lines.push("Agents:");
    for (const a of report.agents) lines.push(`  - ${a.handle} (${a.agent_id}) · ${a.state} · permissions rev ${a.revision ?? "?"}${a.on_this_device ? " · key on this device" : ""}`);
  }
  for (const w of report.warnings) lines.push(`! ${w}`);
  if (report.identity) {
    lines.push("Identity (host-local; disk observations, not live authority verification)");
    const reg = report.identity.registry ?? {};
    const root = report.identityRegistryRoot ?? report.registryRoot ?? report.identity.registryRoot ?? "";
    lines.push(`Registry:  ${reg.state} · sequence ${reg.sequence ?? 0} · ${root}`);
    if (Array.isArray(report.identity.profiles)) {
      for (const p of report.identity.profiles) {
        const prin = p.principalId ?? "-";
        const orig = p.authorityOrigin ?? "-";
        const gen = p.generation != null ? `gen ${p.generation}` : "-";
        lines.push(`  - ${p.state} · ${p.profile} · ${prin} · ${orig} · ${gen}`);
      }
    }
    if (Array.isArray(report.identity.diagnostics)) {
      for (const d of report.identity.diagnostics) {
        const tag = d.severity === "fault" ? "[fault]" : "[warn]";
        const action = d.action ? ` ${d.action}` : "";
        lines.push(`  ${tag} ${d.message}${action}`);
      }
    }
  }
  lines.push("", ...TRUST_COPY.map((line) => `  ${line}`));
  return lines.join("\n");
}
