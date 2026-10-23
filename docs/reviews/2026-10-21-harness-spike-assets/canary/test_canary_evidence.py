#!/usr/bin/env python3
"""Tests for canary-evidence.py. Self-contained: synthetic rollouts built from the record shapes seen in real
Codex 0.163.0-alpha.11.1 rollouts. Run:  python3 test_canary_evidence.py"""
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "canary-evidence.py")
TOKEN = "B1-IDLE-01"
ACK = "canary ack " + TOKEN


def ts(i):
    return "2026-10-22T06:00:%02d.000Z" % i


def turn(tid, token=TOKEN, ack=ACK, trigger="queue", start_ord=0):
    text = "[Triangle wake canary %s] Automated test notification." % token
    o = start_ord
    pt = {"turn_id": tid}
    return [
        {"timestamp": ts(0), "ordinal": o, "type": "event_msg", "payload": {"type": "task_started", "turn_attribution": {"turn_id": tid, "turn_trigger": trigger}, "turn_id": tid}},
        {"timestamp": ts(1), "ordinal": o + 1, "type": "turn_context", "payload": dict(pt)},
        {"timestamp": ts(2), "ordinal": o + 2, "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}], "internal_chat_message_metadata_passthrough": dict(pt)}},
        {"timestamp": ts(2), "ordinal": o + 3, "type": "event_msg", "payload": {"type": "item_completed", "turn_id": tid, "item": {"type": "UserMessage", "content": [{"type": "text", "text": text}]}}},
        {"timestamp": ts(3), "ordinal": o + 4, "type": "event_msg", "payload": {"type": "item_completed", "turn_id": tid, "item": {"type": "AgentMessage", "content": [{"type": "Text", "text": ack}]}}},
        {"timestamp": ts(3), "ordinal": o + 5, "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": ack}], "internal_chat_message_metadata_passthrough": dict(pt)}},
        {"timestamp": ts(4), "ordinal": o + 6, "type": "token_usage_record", "payload": dict(pt)},
        {"timestamp": ts(4), "ordinal": o + 7, "type": "event_msg", "payload": {"type": "token_count"}},
        {"timestamp": ts(5), "ordinal": o + 8, "type": "event_msg", "payload": {"type": "task_complete", "turn_id": tid, "last_agent_message": ack}},
    ]


def seed_turn():
    return turn("TURN-SEED", token="SEED", ack="ready", trigger=None)


def tool_call(**extra):
    r = {"timestamp": ts(3), "ordinal": 99, "type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{}", "call_id": "c1"}}
    r["payload"].update(extra)
    return r


def run(records, token=TOKEN, extra=(), spaced=True, tail=None):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "rollout.jsonl")
    with io.open(p, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) if spaced else json.dumps(r, separators=(",", ":")))
            f.write("\n")
        if tail is not None:
            f.write(tail)
    r = subprocess.run([sys.executable, TOOL, p, token] + list(extra), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return r.returncode, r.stdout + r.stderr


class T(unittest.TestCase):
    def verdict(self, code, out, want, *needles):
        self.assertEqual(code, {"PASS": 0, "FAIL": 1, "INCONCLUSIVE": 2}[want], out)
        self.assertIn("canary-evidence: " + want, out)
        for n in needles:
            self.assertIn(n, out)

    def test_baseline_passes_in_both_json_layouts(self):
        for spaced in (True, False):
            code, out = run(seed_turn() + turn("T1"), spaced=spaced)
            self.verdict(code, out, "PASS", "turn trigger        : queue", "exact line: yes")

    def test_missing_completion_with_tool_call_never_reports_zero(self):  # the reviewer's finding A
        recs = seed_turn() + turn("T1")[:-1]
        recs.insert(len(recs) - 3, tool_call())
        code, out = run(recs)
        self.verdict(code, out, "FAIL", "tool-like record", "no completion marker")

    def test_missing_completion_alone_is_inconclusive(self):
        code, out = run(seed_turn() + turn("T1")[:-1])
        self.verdict(code, out, "INCONCLUSIVE", "no completion marker")

    def test_truncated_transcript(self):
        full = seed_turn() + turn("T1")
        cut = json.dumps(full[-1])[:40]
        code, out = run(full[:-1], tail=cut)
        self.verdict(code, out, "INCONCLUSIVE", "cut off", "no completion marker")

    def test_interleaved_benign_records_from_another_turn(self):
        recs = seed_turn() + turn("T1")
        foreign = [{"timestamp": ts(3), "ordinal": 50, "type": "token_usage_record", "payload": {"turn_id": "T2"}}, {"timestamp": ts(3), "ordinal": 51, "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "T2", "item": {"type": "AgentMessage", "content": []}}}]
        recs[-4:-4] = foreign
        code, out = run(recs)
        self.verdict(code, out, "PASS", "other-turn records inside the window: 2")

    def test_interleaved_tool_call_from_another_turn_is_not_a_pass(self):
        recs = seed_turn() + turn("T1")
        recs[-4:-4] = [tool_call(internal_chat_message_metadata_passthrough={"turn_id": "T2"})]
        code, out = run(recs)
        self.verdict(code, out, "INCONCLUSIVE", "interleaved inside the canary window")

    def test_tool_call_inside_a_completed_turn(self):
        recs = seed_turn() + turn("T1")
        recs.insert(len(recs) - 3, tool_call())
        code, out = run(recs)
        self.verdict(code, out, "FAIL", "tool-like record")

    def test_duplicate_delivery(self):
        t = turn("T1")
        code, out = run(seed_turn() + t + turn("T3"))
        self.verdict(code, out, "FAIL", "duplicate delivery")

    def test_token_absent(self):
        code, out = run(seed_turn() + turn("T1", token="OTHER"))
        self.verdict(code, out, "INCONCLUSIVE", "no user message with the token")

    def test_only_one_form_of_the_user_message(self):
        t = turn("T1")
        del t[2]  # response_item user record
        code, out = run(seed_turn() + t)
        self.verdict(code, out, "INCONCLUSIVE", "do not match")

    def test_aborted_turn(self):
        t = turn("T1")
        t[-1] = {"timestamp": ts(5), "ordinal": 8, "type": "event_msg", "payload": {"type": "turn_aborted", "turn_id": "T1"}}
        code, out = run(seed_turn() + t)
        self.verdict(code, out, "FAIL", "turn_aborted")

    def test_unknown_record_kind_needs_review_then_allow(self):
        recs = seed_turn() + turn("T1")
        recs.insert(len(recs) - 3, {"timestamp": ts(3), "ordinal": 60, "type": "event_msg", "payload": {"type": "brand_new_kind", "turn_id": "T1"}})
        code, out = run(recs)
        self.verdict(code, out, "INCONCLUSIVE", "unclassified")
        code, out = run(recs, extra=["--allow", "event_msg:brand_new_kind"])
        self.verdict(code, out, "PASS")

    def test_wrong_acknowledgement(self):
        code, out = run(seed_turn() + turn("T1", ack="hello there"))
        self.verdict(code, out, "FAIL", "does not contain the acknowledgement")

    def test_two_assistant_messages(self):
        recs = seed_turn() + turn("T1")
        extra = copy.deepcopy(recs[-4])
        recs.insert(len(recs) - 3, extra)
        code, out = run(recs)
        self.verdict(code, out, "INCONCLUSIVE", "expected one assistant message")

    def test_output_never_echoes_other_transcript_content(self):
        secret = "UNRELATED-PRIVATE-NOTE"
        seed = seed_turn()
        seed[2]["payload"]["content"][0]["text"] = secret
        code, out = run(seed + turn("T1"))
        self.assertNotIn(secret, out)


    def busy_then_canary(self, busy_end="task_complete", overlap=False):
        busy = turn("TB", token="BUSYPROMPT", ack="busy done", trigger=None)
        busy.insert(len(busy) - 3, tool_call(internal_chat_message_metadata_passthrough={"turn_id": "TB"}))  # the sleep command
        if busy_end != "task_complete":
            busy[-1] = {"timestamp": ts(5), "ordinal": 8, "type": "event_msg", "payload": {"type": busy_end, "turn_id": "TB"}}
        canary = turn("T1")
        if overlap:  # the canary turn starts before the busy turn has ended
            return seed_turn() + busy[:-1] + canary + [busy[-1]]
        return seed_turn() + busy + canary

    def test_busy_run_canary_after_a_completed_turn_passes_despite_its_tool_call(self):
        code, out = run(self.busy_then_canary(), extra=["--after-token", "BUSYPROMPT"])
        self.verdict(code, out, "PASS", "preceding turn      : TB ended with task_complete")

    def test_busy_run_interrupted_turn_fails(self):
        code, out = run(self.busy_then_canary(busy_end="turn_aborted"), extra=["--after-token", "BUSYPROMPT"])
        self.verdict(code, out, "FAIL", "preceding turn ended with turn_aborted")

    def test_busy_run_canary_not_queued_behind_the_turn_fails(self):
        code, out = run(self.busy_then_canary(overlap=True), extra=["--after-token", "BUSYPROMPT"])
        self.verdict(code, out, "FAIL", "before the preceding turn ended")

    def test_busy_run_preceding_turn_missing_is_inconclusive(self):
        code, out = run(seed_turn() + turn("T1"), extra=["--after-token", "BUSYPROMPT"])
        self.verdict(code, out, "INCONCLUSIVE", "expected one preceding-turn user message")

if __name__ == "__main__":
    unittest.main(verbosity=2)
