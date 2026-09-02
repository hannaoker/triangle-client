import { createOutboundA2AHandler } from "@the-triangle/a2a-gateway/outbound-a2a";

let handler;

export function POST(request) {
  handler ||= createOutboundA2AHandler();
  return handler(request);
}
