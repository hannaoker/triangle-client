#!/usr/bin/env python3
"""Strict evidence collector for the live queue canary (see the harness spike report).

Reads a Codex rollout (JSON Lines), finds the canary turn by its token and prints facts only: counts, ids,
timestamps, record kinds and the acknowledgement line. It never prints other transcript content.

Verdicts and exit codes:  PASS 0  |  FAIL 1  |  INCONCLUSIVE 2.
PASS needs all of: exactly one canary user message (both its record forms), one matching turn with a start
marker and an explicit task_complete marker, zero tool-like records and zero unclassified records in that turn,
and exactly one assistant message containing the acknowledgement. A missing boundary, a truncated or unparseable
transcript, or an unrecognised record kind can never produce PASS.

usage: canary-evidence.py ROLLOUT TOKEN [--ack-text TEXT] [--after-token TOKEN2] [--allow KIND]... [--list-kinds]
  --ack-text   text the assistant must contain (default: "canary ack TOKEN")
  --after-token  busy runs: the user message of the preceding turn contains this text; that turn must have finished
                 with task_complete before the canary turn started (its own records are not examined)
  --allow      treat one more record kind as benign (use only after reviewing --list-kinds output)
  --list-kinds print every record kind seen in the canary turn
"""
import argparse
import io
import json
import re
import sys

BENIGN = {
    "event_msg:task_started", "event_msg:task_complete", "event_msg:token_count", "event_msg:thread_settings_applied",
    "turn_context", "token_usage_record", "world_state",
    "response_item:message", "response_item:reasoning",
    "event_msg:item_started:UserMessage", "event_msg:item_completed:UserMessage",
    "event_msg:item_started:AgentMessage", "event_msg:item_completed:AgentMessage",
    "event_msg:item_started:Reasoning", "event_msg:item_completed:Reasoning",
}
TOOL_RE = re.compile(r"(_call|call_output|exec|patch|mcp|tool|command|function|shell|web_search|CommandExecution|FileChange|McpToolCall|DynamicTool|WebSearch|Collab)", re.I)
TERMINAL = {"event_msg:task_complete": "task_complete", "event_msg:turn_aborted": "turn_aborted", "event_msg:error": "error"}


def payload(o):
    p = o.get("payload")
    return p if isinstance(p, dict) else {}


def turn_of(o):
    p = payload(o)
    if p.get("turn_id"):
        return p["turn_id"]
    m = p.get("internal_chat_message_metadata_passthrough")
    if isinstance(m, dict) and m.get("turn_id"):
        return m["turn_id"]
    ta = p.get("turn_attribution")
    if isinstance(ta, dict) and ta.get("turn_id"):
        return ta["turn_id"]
    return None


def kind(o):
    t, p = o.get("type"), payload(o)
    pt = p.get("type")
    if t == "event_msg" and pt in ("item_started", "item_completed"):
        it = p.get("item") if isinstance(p.get("item"), dict) else {}
        return "event_msg:%s:%s" % (pt, it.get("type"))
    return "%s:%s" % (t, pt) if pt else str(t)


def texts(x):
    out = []
    if isinstance(x, dict):
        for k, v in x.items():
            if k == "text" and isinstance(v, str):
                out.append(v)
            else:
                out.extend(texts(v))
    elif isinstance(x, list):
        for v in x:
            out.extend(texts(v))
    return out


def load(path):
    with io.open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    recs, bad = [], []
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            o = json.loads(line)
        except ValueError:
            bad.append(n)
            continue
        if isinstance(o, dict):
            recs.append((n, o))
        else:
            bad.append(n)
    return recs, bad, len(lines)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("rollout")
    ap.add_argument("token")
    ap.add_argument("--ack-text")
    ap.add_argument("--after-token")
    ap.add_argument("--allow", action="append", default=[])
    ap.add_argument("--list-kinds", action="store_true")
    a = ap.parse_args(argv)
    ack = a.ack_text if a.ack_text is not None else "canary ack %s" % a.token
    benign = BENIGN | set(a.allow)
    fail, inc = [], []

    recs, bad, nlines = load(a.rollout)
    truncated_tail = bool(bad) and bad[-1] == nlines
    if bad:
        inc.append("%d unparseable line(s)%s: %s" % (len(bad), " (the last line is cut off)" if truncated_tail else "", ",".join(map(str, bad[:8]))))

    user_events = [(n, o) for n, o in recs if kind(o) == "event_msg:item_completed:UserMessage" and any(a.token in t for t in texts(payload(o).get("item")))]
    user_resp = [(n, o) for n, o in recs if o.get("type") == "response_item" and payload(o).get("type") == "message" and payload(o).get("role") == "user" and any(a.token in t for t in texts(payload(o).get("content")))]
    if len(user_events) > 1 or len(user_resp) > 1:
        fail.append("duplicate delivery: %d user event(s) and %d user record(s) carry the token" % (len(user_events), len(user_resp)))
    if not user_events and not user_resp:
        inc.append("no user message with the token (not delivered yet, or the wrong rollout)")
    elif len(user_events) == 0 or len(user_resp) == 0:
        inc.append("the token is in %d user event(s) but %d user record(s): the two forms of the message do not match" % (len(user_events), len(user_resp)))

    tid = None
    if user_events:
        tid = turn_of(user_events[0][1])
        if not tid:
            inc.append("the canary user event has no turn id")
    starts = [(n, o) for n, o in recs if kind(o) == "event_msg:task_started" and tid and turn_of(o) == tid]
    terms = [(n, o, TERMINAL[kind(o)]) for n, o in recs if kind(o) in TERMINAL and tid and turn_of(o) == tid]
    if tid and len(starts) != 1:
        inc.append("expected one task_started for the canary turn, found %d" % len(starts))
    if tid and not terms:
        inc.append("no completion marker for the canary turn (still running, truncated, or never finished)")
    if len(terms) > 1:
        inc.append("%d terminal markers for one turn" % len(terms))
    for _n, _o, label in terms:
        if label != "task_complete":
            fail.append("the canary turn ended with %s" % label)

    start_n = starts[0][0] if starts else None
    end_n = terms[0][0] if terms else None
    in_range = []
    if start_n is not None:
        hi = end_n if end_n is not None else (recs[-1][0] if recs else start_n)
        in_range = [(n, o) for n, o in recs if start_n <= n <= hi]
    if user_resp and in_range and not any(n == user_resp[0][0] for n, _ in in_range):
        inc.append("the user record is outside the canary turn's boundaries")

    preceding = None
    if a.after_token:
        pre = [(n, o) for n, o in recs if kind(o) == "event_msg:item_completed:UserMessage" and any(a.after_token in t for t in texts(payload(o).get("item")))]
        if len(pre) != 1:
            inc.append("expected one preceding-turn user message containing %r, found %d" % (a.after_token, len(pre)))
        else:
            ptid = turn_of(pre[0][1])
            pterms = [(n, o, TERMINAL[kind(o)]) for n, o in recs if kind(o) in TERMINAL and ptid and turn_of(o) == ptid]
            if not pterms:
                inc.append("no completion marker for the preceding turn")
            else:
                pn, po, plabel = pterms[0]
                preceding = (ptid, pn, po.get("timestamp"), plabel)
                if plabel != "task_complete":
                    fail.append("the preceding turn ended with %s" % plabel)
                if start_n is not None and pn >= start_n:
                    fail.append("the canary turn started (line %d) before the preceding turn ended (line %d)" % (start_n, pn))

    mine, foreign = [], []
    for n, o in in_range:
        t = turn_of(o)
        (foreign if (t and t != tid) else mine).append((n, o))
    kinds = {}
    tool_like, unclassified = [], []
    for n, o in mine:
        k = kind(o)
        kinds[k] = kinds.get(k, 0) + 1
        if k in benign:
            if k == "response_item:message" and payload(o).get("role") not in ("user", "assistant", "developer"):
                unclassified.append((n, k + ":role=" + str(payload(o).get("role"))))
            continue
        (tool_like if TOOL_RE.search(k) else unclassified).append((n, k))
    foreign_tool = [(n, kind(o)) for n, o in foreign if kind(o) not in benign and TOOL_RE.search(kind(o))]
    if tool_like:
        fail.append("%d tool-like record(s) in the canary turn: %s" % (len(tool_like), ", ".join(sorted(set(k for _, k in tool_like)))))
    if unclassified:
        inc.append("%d unclassified record(s) in the canary turn: %s (review with --list-kinds, then --allow)" % (len(unclassified), ", ".join(sorted(set(k for _, k in unclassified)))))
    if foreign_tool:
        inc.append("%d tool-like record(s) from other turns interleaved inside the canary window" % len(foreign_tool))

    assistants = []
    for n, o in mine:
        p = payload(o)
        if o.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "assistant":
            assistants.append((n, o, " ".join(texts(p.get("content"))).strip()))
    ack_found = [t for _, _, t in assistants if ack in t]
    exact = [t for _, _, t in assistants if t == ack]
    if terms and terms[0][2] == "task_complete":
        if len(assistants) != 1:
            (fail if not assistants else inc).append("expected one assistant message in the canary turn, found %d" % len(assistants))
        elif not ack_found:
            fail.append("the assistant message does not contain the acknowledgement %r" % ack)

    trigger = None
    if starts:
        ta = payload(starts[0][1]).get("turn_attribution")
        trigger = ta.get("turn_trigger") if isinstance(ta, dict) else None

    verdict = "FAIL" if fail else ("INCONCLUSIVE" if inc else "PASS")
    ts = lambda rec: (rec[1].get("timestamp") if rec else None)
    print("canary-evidence: %s" % verdict)
    print("  records             : %d lines, %d unparseable, truncated tail: %s" % (nlines, len(bad), "yes" if truncated_tail else "no"))
    print("  canary user items   : %d event form, %d response form" % (len(user_events), len(user_resp)))
    print("  turn                : %s" % (tid or "none"))
    print("  turn trigger        : %s" % (trigger if trigger is not None else "none recorded"))
    if a.after_token:
        print("  preceding turn      : %s" % ("%s ended with %s at line %d (%s)" % (preceding[0], preceding[3], preceding[1], preceding[2]) if preceding else "not established"))
    print("  start / end         : line %s (%s) / line %s (%s)" % (start_n, ts(starts[0]) if starts else "-", end_n, (ts(terms[0]) + " " + terms[0][2]) if terms else "-"))
    print("  user / assistant ts : %s / %s" % (ts(user_events[0]) if user_events else "-", ts(assistants[0]) if assistants else "-"))
    print("  assistant messages  : %d; acknowledgement found: %s; exact line: %s" % (len(assistants), "yes" if ack_found else "no", "yes" if exact else "no"))
    if assistants:
        print("  assistant text      : %r" % assistants[0][2][:200])
    print("  records in the turn : %d (tool-like %d, unclassified %d); other-turn records inside the window: %d" % (len(mine), len(tool_like), len(unclassified), len(foreign)))
    if a.list_kinds:
        for k in sorted(kinds):
            print("    kind %-48s x%d%s" % (k, kinds[k], "" if k in benign else "   <- not in the benign list"))
    for r in fail:
        print("  FAIL: %s" % r)
    for r in inc:
        print("  INCONCLUSIVE: %s" % r)
    return {"PASS": 0, "FAIL": 1, "INCONCLUSIVE": 2}[verdict]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
