/**
 * Human-readable dashboard rendering (secret-free by construction from collectDashboard).
 */

/**
 * @param {object} dashboard
 * @returns {string}
 */
export function formatDashboardHuman(dashboard) {
  const lines = [];
  lines.push("Triangle Client Console — read-only status");
  lines.push(`generatedAt: ${dashboard.generatedAt ?? "?"}`);
  lines.push("");

  lines.push("## Helper / client binaries");
  lines.push(
    `helper: ${flag(dashboard.helper?.present)} present, ${flag(dashboard.helper?.executable)} executable (${dashboard.helper?.reason ?? "?"})`,
  );
  lines.push(
    `client: ${flag(dashboard.clientBinary?.present)} present, ${flag(dashboard.clientBinary?.executable)} executable (${dashboard.clientBinary?.reason ?? "?"})`,
  );
  lines.push(`installationId: ${dashboard.installationId ?? "(none)"}`);
  lines.push("");

  lines.push("## Instances (triangle-client agent list)");
  if (!dashboard.agents?.length) {
    lines.push("(none)");
  } else {
    for (const agent of dashboard.agents) {
      lines.push(
        `- ${agent.profile}: runtime=${agent.runtimeAdapter} delivery=${agent.deliveryMode} enabled=${agent.enabled} instance=${shortId(agent.instanceId)}`,
      );
    }
  }
  lines.push("");

  lines.push("## Enrolled profile status (triangle-mailbox status)");
  if (!dashboard.profiles?.length) {
    lines.push("(none queried)");
  } else {
    for (const profile of dashboard.profiles) {
      lines.push(
        `- ${profile.profile}: lifecycle=${profile.lifecycle} handle=${profile.handle ?? "—"} action=${profile.operatorAction ?? "—"}`,
      );
    }
  }
  lines.push("");

  lines.push("## Watch grant (triangle-mailbox watch-status)");
  if (!dashboard.watch) {
    lines.push("(not available — pass --installation or ensure client/installation.json)");
  } else {
    const w = dashboard.watch;
    lines.push(
      `state=${w.state} listenerReady=${w.listenerReady} members=${w.memberCount} action=${w.operatorAction}`,
    );
  }
  lines.push("");

  lines.push("## Service");
  if (dashboard.service?.summary) {
    lines.push(dashboard.service.summary);
  } else {
    lines.push(dashboard.service?.note ?? "(service status not collected)");
  }
  lines.push("");

  lines.push("## Later actions (stubs / explicit)");
  lines.push(`- enroll: ${dashboard.stubs?.enroll}`);
  lines.push(`- watch-ensure: ${dashboard.stubs?.watchEnsure}`);
  lines.push(`- service: ${dashboard.stubs?.serviceControl}`);

  if (dashboard.errors?.length) {
    lines.push("");
    lines.push("## Errors");
    for (const err of dashboard.errors) {
      lines.push(`- [${err.code}] ${err.scope ? `${err.scope}: ` : ""}${err.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function flag(value) {
  return value ? "yes" : "no";
}

function shortId(value) {
  if (typeof value !== "string" || value.length < 12) return value ?? "—";
  return `${value.slice(0, 8)}…`;
}
