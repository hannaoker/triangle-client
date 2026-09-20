import gateway from "../api/gateway.mjs";
import { createForwardGatewayRequest } from "@the-triangle/a2a-gateway/next";

export const forwardGatewayRequest = createForwardGatewayRequest(gateway);
