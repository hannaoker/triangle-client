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
  function pin(input) {
    const route = createLocalReplyRoute(input);
    return transaction(() => {
      const old = read(route.key);
      // Pin admission is immutable; generation advancement belongs to the
      // authenticated reply transaction, not a repeated request admission.
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(route)) {
          throw coded("reply_route_conflict", "Conversation already has a different reply pin");
        }
        return old;
      }
      db.prepare("INSERT INTO local_reply_routes(route_key,route_json) VALUES(?,?)").run(route.key, JSON.stringify(route));
      return route;
    });
  }
  function withReply({ key, local, remote, writeReply } = {}) {
    if (typeof writeReply !== "function" || writeReply.constructor.name === "AsyncFunction") {
      throw coded("invalid_reply_writer", "Synchronous same-connection reply writer required");
    }
    return transaction(() => {
      const old = read(key);
      if (!old) throw coded("reply_route_missing", "No pinned reply route");
      const next = verifyLocalReplyRoute(old, { local, remote });
      const result = writeReply(db);
      if (result && typeof result.then === "function") throw coded("async_reply_transaction", "Reply writes must be synchronous");
      db.prepare("UPDATE local_reply_routes SET route_json=? WHERE route_key=?").run(JSON.stringify(next), key);
      return Object.freeze({ route: next, result });
    });
  }
  return Object.freeze({ read, pin, withReply });
}
