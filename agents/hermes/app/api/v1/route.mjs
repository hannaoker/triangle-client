import { forwardGatewayRequest } from "../../_gateway-route.mjs";
import { createGatewayRouteHandlers } from "@the-triangle/a2a-gateway/next";

export const { POST } = createGatewayRouteHandlers(forwardGatewayRequest, ["POST"]);
