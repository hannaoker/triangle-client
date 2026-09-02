import { forwardGatewayRequest } from "../../_gateway-route.mjs";

export function POST(request) {
  return forwardGatewayRequest(request);
}
