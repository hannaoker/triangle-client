CREATE TABLE IF NOT EXISTS a2a_correlations (
  gateway_key TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  mesh_room_id TEXT NOT NULL,
  mesh_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (gateway_key, sender_agent_id, context_id, task_id, message_id),
  UNIQUE (gateway_key, mesh_event_id)
);

CREATE INDEX IF NOT EXISTS a2a_correlations_sender_tasks_idx
  ON a2a_correlations (
    gateway_key,
    sender_agent_id,
    created_at,
    task_id,
    context_id,
    message_id
  );
