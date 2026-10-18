// Owner devices (§3.4): approve a device that joined with a device invite, or
// revoke one. Devices are addressed by the fingerprint each one prints, which
// is resolved to its key thumbprint from the server's device list.
import { fingerprint } from "./keys.mjs";
import { LocalStateError } from "./errors.mjs";

const FINGERPRINT = /^[A-Z0-9_-]{4}(?:-[A-Z0-9_-]{4}){3}$/;
const JKT = /^[A-Za-z0-9_-]{43}$/;

export async function listDevices(session) {
  const { body } = await session.ownerRequest("GET", "/api/v1/owners/me");
  return (body.controllers ?? []).map((c) => ({ ...c, fingerprint: c.jkt ? fingerprint(c.jkt) : null, this_device: c.controller_id === body.calling_controller_id }));
}

export function resolveDevice(devices, ref) {
  const value = String(ref ?? "").trim();
  if (JKT.test(value)) {
    const hit = devices.find((d) => d.jkt === value);
    if (!hit) throw new LocalStateError("No device of yours has that key.");
    return hit;
  }
  const wanted = value.toUpperCase();
  if (!FINGERPRINT.test(wanted)) throw new TypeError("Give the device fingerprint it printed (XXXX-XXXX-XXXX-XXXX).");
  const hits = devices.filter((d) => d.fingerprint === wanted);
  if (hits.length !== 1) throw new LocalStateError(hits.length ? "That fingerprint matches several devices; use its full key thumbprint." : "No device of yours shows that fingerprint. Check it on the other computer (`triangle status`).");
  return hits[0];
}

export async function approveDevice(session, ref) {
  return session.custody.withLock(async () => {
    const device = resolveDevice(await listDevices(session), ref);
    if (device.state !== "pending_approval") throw new LocalStateError(`${device.device_label ?? "That device"} is ${device.state}, not waiting for approval.`);
    const response = await session.ownerOperation("owner.device.approve", device.jkt, {});
    return { ...response.result, device_label: device.device_label, fingerprint: device.fingerprint, outcome: response.outcome };
  });
}

export async function revokeDevice(session, ref, { allowSelf = false } = {}) {
  return session.custody.withLock(async () => {
    const device = resolveDevice(await listDevices(session), ref);
    if (device.this_device && !allowSelf) throw new TypeError("That is this device. Revoke it from another device, or pass --yes to lock this device out of your account.");
    const response = await session.ownerOperation("owner.device.revoke", device.jkt, {});
    return { ...response.result, device_label: device.device_label, fingerprint: device.fingerprint, outcome: response.outcome };
  });
}

export function renderDevices(devices) {
  return devices.map((d) => `${d.fingerprint ?? "????"}  ${d.state.padEnd(16)} ${d.device_label ?? d.kind}${d.this_device ? "  (this device)" : ""}`).join("\n") || "No devices.";
}
