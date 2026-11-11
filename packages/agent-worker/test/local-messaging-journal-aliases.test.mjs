// AD.1: how the journal tells a retry from a changed intent when a send was addressed by an owner-set alias
// (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md, 3.5). For a retry, `principal` and `alias` are one intent:
// the principal the send resolved to. The alias name is not stored.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";

const SENDER = "a".repeat(64);
const P = `agent_${"1".repeat(32)}`;
const P2 = `agent_${"2".repeat(32)}`;

function withJournal(run) {
  const base = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, "tri-alias-journal-"));
  fs.chmodSync(dir, 0o700);
  const journal = createLocalMessagingJournal({ stateRoot: dir });
  return Promise.resolve(run(journal)).finally(() => {
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// one recipient per case, so the journal's limit on exchanges between a pair (10 in ten minutes) is not what this test measures
const recipientFor = (messageId) => createHash("sha256").update(messageId).digest("hex");
const envelope = (messageId, route) => ({
  sender: SENDER,
  recipient: recipientFor(messageId),
  recipientType: "runner",
  messageId,
  requestId: `req-${messageId}`,
  text: "same text",
  metadata: {},
  to_principal: route.principal,
  resolved_via: route.via,
});

// Whether a second send under the same message id, with the same envelope, counts as a retry of the first.
async function isRetry(journal, id, stored, incoming) {
  await journal.recordSend(envelope(id, stored));
  try {
    const second = await journal.recordSend(envelope(id, incoming));
    return second.isDuplicate === true;
  } catch (error) {
    assert.equal(error.code, "duplicate_id_conflict", `${id}: only a changed intent may refuse a retry`);
    return false;
  }
}

test("a principal send and an alias send of the same principal are one intent; anything else is a changed intent", async () => {
  const cases = [
    // [stored, incoming, retry?]
    [{ principal: P, via: "alias" }, { principal: P, via: "alias" }, true],
    [{ principal: P, via: "alias" }, { principal: P, via: "principal" }, true],
    [{ principal: P, via: "principal" }, { principal: P, via: "alias" }, true],
    [{ principal: P, via: "principal" }, { principal: P, via: "principal" }, true],
    [{ principal: P, via: "alias" }, { principal: P2, via: "alias" }, false],
    [{ principal: P, via: "alias" }, { principal: P2, via: "principal" }, false],
    [{ principal: P, via: "alias" }, { principal: null, via: "id" }, false],
    [{ principal: P, via: "alias" }, { principal: null, via: null }, false],
    [{ principal: null, via: "id" }, { principal: P, via: "alias" }, false],
    [{ principal: null, via: null }, { principal: P, via: "alias" }, false],
    // a send by exact id never carries a principal, and never counts as an alias or principal send
    [{ principal: null, via: "id" }, { principal: null, via: "alias" }, false],
    [{ principal: null, via: null }, { principal: null, via: "alias" }, false],
    [{ principal: null, via: "alias" }, { principal: null, via: "id" }, false],
    [{ principal: null, via: "principal" }, { principal: null, via: "id" }, false],
    // today's rows are unchanged
    [{ principal: null, via: "id" }, { principal: null, via: "id" }, true],
    [{ principal: null, via: null }, { principal: null, via: "id" }, true],
    [{ principal: null, via: "id" }, { principal: null, via: null }, true],
    // an unknown marker is not an intent
    [{ principal: P, via: "weird" }, { principal: P, via: "alias" }, false],
    [{ principal: P, via: null }, { principal: P, via: "alias" }, false],
  ];
  await withJournal(async (journal) => {
    for (const [index, [stored, incoming, expected]] of cases.entries()) {
      assert.equal(await isRetry(journal, `m-${index}`, stored, incoming), expected, `${JSON.stringify(stored)} then ${JSON.stringify(incoming)}`);
    }
  });
});

test("an alias send is stored with the principal and the marker, and the alias name is nowhere in the row", async () => {
  await withJournal(async (journal) => {
    await journal.recordSend(envelope("m-row", { principal: P, via: "alias" }));
    const row = await journal.getRecord("m-row");
    assert.deepEqual([row.recipient, row.to_principal, row.resolved_via], [recipientFor("m-row"), P, "alias"]);
  });
});
