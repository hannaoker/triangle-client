#!/usr/bin/env python3
"""
mesh_client.py / mesh CLI
High-level, atomic client for Triangle MESH A2A Mailbox coordination.
"""

import os
import json
import time
import secrets
import argparse
import subprocess
import shutil
import sys

DEFAULT_PROFILE = os.environ.get("MESH_PROFILE", "dawn-hermes-mini-seven")


def resolve_mailbox_bin():
  """Resolve triangle-mailbox binary: env override, macOS install path, then PATH."""
  env_bin = os.environ.get("TRIANGLE_MAILBOX_BIN")
  if env_bin:
    return os.path.expanduser(env_bin)
  macos_default = os.path.expanduser(
    "~/Library/Application Support/The Triangle/bin/triangle-mailbox"
  )
  if os.path.isfile(macos_default):
    return macos_default
  on_path = shutil.which("triangle-mailbox")
  if on_path:
    return on_path
  return macos_default


DEFAULT_BIN = resolve_mailbox_bin()


def mcp_call_failed(res):
  if not res:
    return True, "no response from triangle-mailbox mcp"
  if "error" in res:
    err = res["error"]
    if isinstance(err, dict):
      return True, err.get("message") or json.dumps(err)
    return True, str(err)
  result = res.get("result")
  if not isinstance(result, dict):
    return True, "missing result in MCP response"
  if result.get("isError"):
    content = result.get("content") or []
    text = ""
    if content and isinstance(content[0], dict):
      text = content[0].get("text", "")
    structured = result.get("structuredContent")
    return True, text or json.dumps(structured, indent=2)
  return False, None


def call_mcp(name, args, profile=DEFAULT_PROFILE, bin_path=DEFAULT_BIN, retries=3, timeout=20):
  last_error = ""
  last_stderr = ""
  for attempt in range(retries):
    try:
      proc = subprocess.Popen(
        [bin_path, "mcp", "--profile", profile],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
      )
      req = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": args},
      }).encode("utf-8") + b"\n"
      out, err = proc.communicate(input=req, timeout=timeout)
      last_stderr = err.decode("utf-8", errors="replace").strip() if err else ""
      if proc.returncode != 0:
        last_error = f"triangle-mailbox mcp exited {proc.returncode}"
        time.sleep(0.3)
        continue
      if not out or not out.strip():
        last_error = "empty MCP response"
        time.sleep(0.3)
        continue
      try:
        parsed = json.loads(out.decode("utf-8"))
      except json.JSONDecodeError as exc:
        last_error = f"invalid JSON response: {exc}"
        time.sleep(0.3)
        continue
      failed, err_msg = mcp_call_failed(parsed)
      if failed:
        last_error = err_msg or "MCP tool call failed"
        time.sleep(0.3)
        continue
      return parsed
    except subprocess.TimeoutExpired:
      last_error = f"timed out after {timeout}s"
      try:
        proc.kill()
      except Exception:
        pass
    except Exception as exc:
      last_error = str(exc)
    time.sleep(0.3)

  print(
    f"mesh: MCP call {name} failed after {retries} attempts: {last_error}",
    file=sys.stderr,
  )
  if last_stderr:
    print(f"mesh: {last_stderr}", file=sys.stderr)
  return None


def get_status(profile=DEFAULT_PROFILE, bin_path=DEFAULT_BIN):
  try:
    out = subprocess.check_output([bin_path, "status", "--profile", profile], text=True)
    return json.loads(out)
  except Exception as exc:
    return {"error": str(exc)}


def get_room_history(room_id, limit=50, after_sequence=0, profile=DEFAULT_PROFILE):
  fetch_limit = 100 if after_sequence == 0 else limit
  res = call_mcp("mesh.rooms.history", {
    "room_id": room_id,
    "limit": fetch_limit,
    "after_sequence": after_sequence,
  }, profile=profile)
  if res and "result" in res and "structuredContent" in res["result"]:
    items = res["result"]["structuredContent"].get("items", [])
    if after_sequence == 0 and len(items) > limit:
      return items[-limit:]
    return items
  return []


def poll_mailbox(wait_seconds=0, interval=5, profile=DEFAULT_PROFILE):
  start = time.time()
  while True:
    res = call_mcp("mesh.mailbox.list", {}, profile=profile)
    items = []
    if res and "result" in res and "structuredContent" in res["result"]:
      items = res["result"]["structuredContent"].get("items", [])

    if items or wait_seconds <= 0 or (time.time() - start) >= wait_seconds:
      enriched = []
      for item in items:
        delivery_id = item.get("deliveryId")
        room_id = item.get("roomId")
        event_id = item.get("eventId")

        events = get_room_history(room_id, limit=20, profile=profile)
        target_event = next((ev for ev in events if ev.get("id") == event_id), None)

        body = target_event.get("body", {}) if target_event else {}
        sender = target_event.get("senderAgentId", "") if target_event else ""

        enriched.append({
          "deliveryId": delivery_id,
          "roomId": room_id,
          "eventId": event_id,
          "senderAgentId": sender,
          "replyRequired": body.get("replyRequired", False),
          "text": body.get("text", ""),
          "rawBody": body,
          "createdAt": item.get("createdAt"),
        })
      return enriched

    time.sleep(interval)


def claim_delivery(delivery_id, claim_id=None, profile=DEFAULT_PROFILE):
  if not claim_id:
    claim_id = f"claim_{secrets.token_hex(16)}"
  res = call_mcp("mesh.mailbox.claim", {
    "delivery_id": delivery_id,
    "claim_id": claim_id,
  }, profile=profile)
  return res, claim_id


def send_message(
  room_id,
  text,
  in_reply_to_event_id=None,
  reply_required=False,
  idempotency_key=None,
  profile=DEFAULT_PROFILE,
):
  if not idempotency_key:
    idempotency_key = f"msg-{int(time.time() * 1000)}-{secrets.token_hex(4)}"

  body = {
    "text": text,
    "replyRequired": reply_required,
  }
  if in_reply_to_event_id:
    body["inReplyToEventId"] = in_reply_to_event_id

  res = call_mcp("mesh.messages.send", {
    "room_id": room_id,
    "type": "message.created",
    "body": body,
    "idempotency_key": idempotency_key,
  }, profile=profile)
  return res


def ack_deliveries(delivery_ids, profile=DEFAULT_PROFILE):
  if isinstance(delivery_ids, int):
    delivery_ids = [delivery_ids]
  return call_mcp("mesh.mailbox.ack", {
    "delivery_ids": delivery_ids,
    "status": "processed",
  }, profile=profile)


def reply_atomic(delivery_id, text, reply_required=False, profile=DEFAULT_PROFILE):
  """
  Claim, reply, and ack a delivery. Fails closed if any step errors.
  """
  base = {
    "deliveryId": delivery_id,
    "roomId": None,
    "eventId": None,
    "claimId": None,
  }

  deliveries = poll_mailbox(wait_seconds=0, profile=profile)
  target = next((d for d in deliveries if d.get("deliveryId") == delivery_id), None)

  room_id = None
  event_id = None
  if target:
    room_id = target["roomId"]
    event_id = target["eventId"]
  else:
    res = call_mcp("mesh.mailbox.list", {}, profile=profile)
    if res and "result" in res and "structuredContent" in res["result"]:
      raw_items = res["result"]["structuredContent"].get("items", [])
      raw_target = next(
        (item for item in raw_items if item.get("deliveryId") == delivery_id),
        None,
      )
      if raw_target:
        room_id = raw_target.get("roomId")
        event_id = raw_target.get("eventId")

  if not room_id:
    return {
      "ok": False,
      "step": "lookup",
      "error": f"Delivery ID {delivery_id} not found in pending mailbox.",
      **base,
    }

  base["roomId"] = room_id
  base["eventId"] = event_id

  claim_res, claim_id = claim_delivery(delivery_id, profile=profile)
  base["claimId"] = claim_id
  failed, err = mcp_call_failed(claim_res)
  if failed:
    return {"ok": False, "step": "claim", "error": err, **base}

  send_res = send_message(
    room_id=room_id,
    text=text,
    in_reply_to_event_id=event_id,
    reply_required=reply_required,
    profile=profile,
  )
  failed, err = mcp_call_failed(send_res)
  if failed:
    return {"ok": False, "step": "send", "error": err, **base}

  ack_res = ack_deliveries([delivery_id], profile=profile)
  failed, err = mcp_call_failed(ack_res)
  if failed:
    return {"ok": False, "step": "ack", "error": err, **base}

  return {
    "ok": True,
    **base,
    "sendResult": send_res.get("result", {}).get("structuredContent", {}).get("event", {}),
    "ack": ack_res.get("result", {}).get("structuredContent", {}),
  }


def open_direct_room(recipient_agent_id_or_handle, profile=DEFAULT_PROFILE):
  agent_id = recipient_agent_id_or_handle
  if not agent_id.startswith("agent_"):
    agents_res = call_mcp(
      "mesh.agents.find",
      {"query": recipient_agent_id_or_handle},
      profile=profile,
    )
    if agents_res and "result" in agents_res and "structuredContent" in agents_res["result"]:
      agents = agents_res["result"]["structuredContent"].get("agents", [])
      match = next(
        (
          a for a in agents
          if a.get("handle") == recipient_agent_id_or_handle
          or a.get("name") == recipient_agent_id_or_handle
        ),
        None,
      )
      if match:
        agent_id = match["id"]

  return call_mcp("mesh.rooms.direct.open", {"recipient_agent_id": agent_id}, profile=profile)


def main():
  parser = argparse.ArgumentParser(description="Triangle MESH A2A CLI")
  parser.add_argument(
    "--profile",
    "-p",
    default=DEFAULT_PROFILE,
    help=f"Profile name (default: {DEFAULT_PROFILE})",
  )
  subparsers = parser.add_subparsers(dest="command", required=True)

  subparsers.add_parser("status", help="Get agent profile status")

  poll_parser = subparsers.add_parser("poll", help="Poll pending mailbox deliveries")
  poll_parser.add_argument("--wait", "-w", type=int, default=0, help="Max seconds to wait for delivery")
  poll_parser.add_argument("--interval", "-i", type=int, default=5, help="Poll interval in seconds")

  hist_parser = subparsers.add_parser("history", help="Get room message history")
  hist_parser.add_argument("room_id", help="Room ID")
  hist_parser.add_argument("--limit", "-n", type=int, default=20, help="Max messages to fetch")

  reply_parser = subparsers.add_parser("reply", help="Atomically claim, reply, and ack a delivery")
  reply_parser.add_argument("--delivery", "-d", type=int, required=True, help="Delivery ID to reply to")
  reply_parser.add_argument("--text", "-t", required=True, help="Reply message text")
  reply_parser.add_argument("--reply-required", action="store_true", help="Require peer to reply")

  send_parser = subparsers.add_parser("send", help="Send a message to a room")
  send_parser.add_argument("--room", "-r", required=True, help="Room ID")
  send_parser.add_argument("--text", "-t", required=True, help="Message text")
  send_parser.add_argument("--in-reply-to", help="Event ID to reply to")
  send_parser.add_argument("--reply-required", action="store_true", help="Require peer to reply")

  open_parser = subparsers.add_parser("open", help="Open a direct room with an agent")
  open_parser.add_argument("agent", help="Recipient Agent ID or handle")

  find_parser = subparsers.add_parser("find", help="Find agents on MESH")
  find_parser.add_argument("query", nargs="?", default="", help="Search query")

  args = parser.parse_args()

  if args.command == "status":
    print(json.dumps(get_status(profile=args.profile), indent=2))
  elif args.command == "poll":
    res = poll_mailbox(wait_seconds=args.wait, interval=args.interval, profile=args.profile)
    print(json.dumps(res, indent=2))
  elif args.command == "history":
    res = get_room_history(args.room_id, limit=args.limit, profile=args.profile)
    print(json.dumps(res, indent=2))
  elif args.command == "reply":
    res = reply_atomic(args.delivery, args.text, reply_required=args.reply_required, profile=args.profile)
    print(json.dumps(res, indent=2))
    if not res.get("ok"):
      sys.exit(1)
  elif args.command == "send":
    res = send_message(
      args.room,
      args.text,
      in_reply_to_event_id=args.in_reply_to,
      reply_required=args.reply_required,
      profile=args.profile,
    )
    print(json.dumps(res, indent=2))
    failed, _ = mcp_call_failed(res)
    if failed:
      sys.exit(1)
  elif args.command == "open":
    res = open_direct_room(args.agent, profile=args.profile)
    print(json.dumps(res, indent=2))
    failed, _ = mcp_call_failed(res)
    if failed:
      sys.exit(1)
  elif args.command == "find":
    res = call_mcp(
      "mesh.agents.find",
      {"query": args.query} if args.query else {},
      profile=args.profile,
    )
    print(json.dumps(res, indent=2))
    failed, _ = mcp_call_failed(res)
    if failed:
      sys.exit(1)


if __name__ == "__main__":
  main()
