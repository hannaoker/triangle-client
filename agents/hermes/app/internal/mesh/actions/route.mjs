import { createMeshActionHandler } from "../../../../lib/mesh-actions.mjs";

let handler;

export function POST(request) {
  handler ||= createMeshActionHandler();
  return handler(request);
}

