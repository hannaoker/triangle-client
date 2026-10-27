import { createLocalReplyRoute, verifyLocalReplyRoute } from "./local-reply-route-contract.mjs";
import { coded } from "./local-messaging-errors.mjs";

// Receives a caller-owned SQLite connection. Not a second journal/daemon.
// Future integration must pass the message journal's SAME connection, and use
// withReply() instead of nesting the existing reply-admission transaction.
export function createLocalReplyRouteStore({ db } = {}) {
  if (typeof db?.exec !== "function" || typeof db?.prepare !== "function") {
    throw coded("invalid_reply_store", "SQLite connection required");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS local_reply_routes (
    route_key TEXT PRIMARY KEY, route_json TEXT NOT NULL
  )`);
  function read(key) {
    const row = db.prepare("SELECT route_json FROM local_reply_routes WHERE route_key=?").get(key);
    if (!row) return null;
    let route;
    try { route = JSON.parse(row.route_json); } catch { throw coded("invalid_reply_route", "Stored route is malformed"); }
    const valid = createLocalReplyRoute(route);
    if (route.schema !== valid.schema || route.transport !== valid.transport || route.key !== valid.key || route.key !== key) {
      throw coded("invalid_reply_route", "Stored route identity mismatch");
    }
    return valid;
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (result && typeof result.then === "function") throw coded("async_reply_transaction", "Reply writes must be synchronous");
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  function requireTransaction() {
    if (db.isTransaction !== true) throw coded("reply_transaction_required", "Journal transaction required");
  }
  function pinInTransaction(input) {
    requireTransaction();
    const route = createLocalReplyRoute(input);
    const old = read(route.key);
    if (old) {
      let next;
      try { next = verifyLocalReplyRoute(old, { local: route.local, remote: route.remote }); }
      catch { throw coded("reply_route_conflict", "Conversation already has a different or newer reply pin"); }
      db.prepare("UPDATE local_reply_routes SET route_json=? WHERE route_key=?").run(JSON.stringify(next), route.key);
      return next;
    }
    db.prepare("INSERT INTO local_reply_routes(route_key,route_json) VALUES(?,?)").run(route.key, JSON.stringify(route));
    return route;
  }
  function verifyInTransaction({ key, local, remote }) {
    requireTransaction();
    const old = read(key);
    if (!old) throw coded("reply_route_missing", "No pinned reply route");
    return verifyLocalReplyRoute(old, { local, remote });
  }
  function advanceInTransaction(input) {
    const next = verifyInTransaction(input);
    db.prepare("UPDATE local_reply_routes SET route_json=? WHERE route_key=?").run(JSON.stringify(next), input.key);
    return next;
  }
  function pin(input) {
    return transaction(() => pinInTransaction(input));
  }
  function withReply({ key, local, remote, writeReply } = {}) {
    if (typeof writeReply !== "function" || writeReply.constructor.name === "AsyncFunction") {
      throw coded("invalid_reply_writer", "Synchronous same-connection reply writer required");
    }
    return transaction(() => {
      const next = verifyInTransaction({ key, local, remote });
      const result = writeReply(db);
      if (result && typeof result.then === "function") throw coded("async_reply_transaction", "Reply writes must be synchronous");
      db.prepare("UPDATE local_reply_routes SET route_json=? WHERE route_key=?").run(JSON.stringify(next), key);
      return Object.freeze({ route: next, result });
    });
  }
  return Object.freeze({ read, pin, withReply, pinInTransaction, verifyInTransaction, advanceInTransaction });
}
