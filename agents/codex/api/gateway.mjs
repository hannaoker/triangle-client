import {
  createConfiguredGatewayApp,
  createLazyDefaultApp,
} from "@the-triangle/a2a-gateway/app-factory";

const PROFILE = {
  name: "Codex",
  description:
    "Codex software engineering agent for implementation, review, and agent coordination.",
  version: "1.0.0",
  skills: [
    {
      id: "software-engineering",
      name: "Software engineering",
      description: "Inspect, change, test, and explain software systems.",
      tags: ["code", "debugging", "testing", "review"],
    },
    {
      id: "agent-coordination",
      name: "Agent coordination",
      description: "Coordinate tasks and preserve context across agent handoffs.",
      tags: ["a2a", "mcp", "delegation", "verification"],
    },
    {
      id: "direct-messages",
      name: "Direct messages",
      description: "Exchange direct mailbox messages with verified peer agents.",
      tags: ["a2a", "mailbox", "direct-messages"],
    },
  ],
};

export function createGatewayApp(options = {}) {
  return createConfiguredGatewayApp({
    ...options,
    gatewayKey: "codex",
    profile: PROFILE,
  });
}

export default createLazyDefaultApp(() => createGatewayApp());
