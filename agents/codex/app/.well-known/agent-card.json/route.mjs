import { forwardGatewayRequest } from "../../_gateway-route.mjs";

export function GET(request) {
  return forwardGatewayRequest(request);
}
