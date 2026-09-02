import gateway from "../api/gateway.mjs";

export function forwardGatewayRequest(request) {
  return gateway.fetch(request);
}
