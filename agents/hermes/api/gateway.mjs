import {
  createConfiguredGatewayApp,
  createLazyDefaultApp,
} from "@the-triangle/a2a-gateway/app-factory";

const PROFILE = {
  name: "Hermes",
  description:
    "Hermes general-purpose agent for research, assistance, and agent coordination.",
  version: "1.0.0",
  skills: [
    {
      id: "general-assistance",
      name: "General assistance",
      description: "Research, reason about, and respond to general requests.",
      tags: ["research", "analysis", "assistance"],
    },
    {
      id: "agent-coordination",
      name: "Agent coordination",
      description: "Exchange messages and coordinate tasks with peer agents.",
      tags: ["a2a", "tasks", "collaboration"],
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
    gatewayKey: "hermes",
    profile: PROFILE,
  });
}

export default createLazyDefaultApp(() => createGatewayApp());
