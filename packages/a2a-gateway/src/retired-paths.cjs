"use strict";

/** Tombstoned private gateway routes — keep 404 behavior in sync across handlers. */
const RETIRED_PATHS = Object.freeze(
  new Set(["/inbox", "/inbox/ack", "/internal/tasks/update"]),
);

module.exports = { RETIRED_PATHS };
