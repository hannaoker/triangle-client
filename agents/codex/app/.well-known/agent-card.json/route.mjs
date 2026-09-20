import { forwardGatewayRequest } from "../../_gateway-route.mjs";
import { createGatewayRouteHandlers } from "@the-triangle/a2a-gateway/next";

export const { GET } = createGatewayRouteHandlers(forwardGatewayRequest, ["GET"]);
