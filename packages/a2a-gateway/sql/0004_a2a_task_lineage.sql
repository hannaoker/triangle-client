BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS a2a_task_lineage (
  gateway_key TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  mesh_room_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (gateway_key, sender_agent_id, task_id)
);

CREATE TABLE a2a_lineage_migration_preflight (
  conflict INTEGER NOT NULL
);

CREATE TRIGGER a2a_lineage_migration_preflight_abort
BEFORE INSERT ON a2a_lineage_migration_preflight
BEGIN
  SELECT RAISE(ROLLBACK, 'A2A task lineage migration conflict');
END;

WITH authority AS (
  SELECT gateway_key, sender_agent_id, task_id,
         MIN(context_id) AS context_id,
         MIN(mesh_room_id) AS mesh_room_id,
         COUNT(DISTINCT context_id) AS context_count,
         COUNT(DISTINCT mesh_room_id) AS room_count
  FROM a2a_correlations
  GROUP BY gateway_key, sender_agent_id, task_id
), conflicts AS (
  SELECT 1 AS conflict FROM authority
  WHERE context_count != 1 OR room_count != 1
  UNION ALL
  SELECT 1 AS conflict
  FROM a2a_task_lineage AS lineage
  INNER JOIN authority
    ON authority.gateway_key = lineage.gateway_key
   AND authority.sender_agent_id = lineage.sender_agent_id
   AND authority.task_id = lineage.task_id
  WHERE authority.context_count = 1 AND authority.room_count = 1
    AND (lineage.context_id != authority.context_id
      OR (lineage.mesh_room_id IS NOT NULL
        AND lineage.mesh_room_id != authority.mesh_room_id))
)
INSERT INTO a2a_lineage_migration_preflight (conflict)
SELECT conflict FROM conflicts LIMIT 1;

DROP TRIGGER a2a_lineage_migration_preflight_abort;
DROP TABLE a2a_lineage_migration_preflight;

WITH authority AS (
  SELECT gateway_key, sender_agent_id, task_id,
         MIN(context_id) AS context_id,
         MIN(mesh_room_id) AS mesh_room_id,
         MIN(created_at) AS created_at,
         MAX(updated_at) AS updated_at
  FROM a2a_correlations
  GROUP BY gateway_key, sender_agent_id, task_id
)
INSERT INTO a2a_task_lineage (
  gateway_key, sender_agent_id, task_id, context_id, mesh_room_id,
  created_at, updated_at
)
SELECT gateway_key, sender_agent_id, task_id, context_id, mesh_room_id,
       created_at, updated_at
FROM authority
WHERE true
ON CONFLICT (gateway_key, sender_agent_id, task_id) DO UPDATE
SET mesh_room_id = excluded.mesh_room_id,
    updated_at = excluded.updated_at
WHERE a2a_task_lineage.context_id = excluded.context_id
  AND a2a_task_lineage.mesh_room_id IS NULL;

CREATE TRIGGER IF NOT EXISTS a2a_correlations_lineage_insert_guard
BEFORE INSERT ON a2a_correlations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM a2a_correlations AS existing
    WHERE (
        (existing.gateway_key = NEW.gateway_key
          AND existing.sender_agent_id = NEW.sender_agent_id
          AND existing.context_id = NEW.context_id
          AND existing.task_id = NEW.task_id
          AND existing.message_id = NEW.message_id)
        OR (existing.gateway_key = NEW.gateway_key
          AND existing.mesh_event_id = NEW.mesh_event_id)
      )
      AND NOT (
        existing.gateway_key IS NEW.gateway_key
        AND existing.sender_agent_id IS NEW.sender_agent_id
        AND existing.context_id IS NEW.context_id
        AND existing.task_id IS NEW.task_id
        AND existing.message_id IS NEW.message_id
        AND existing.mesh_room_id IS NEW.mesh_room_id
        AND existing.mesh_event_id IS NEW.mesh_event_id
        AND existing.mesh_event_sequence IS NEW.mesh_event_sequence
        AND existing.payload_hash IS NEW.payload_hash
        AND existing.created_at IS NEW.created_at
        AND existing.updated_at IS NEW.updated_at
      )
  ) THEN RAISE(ABORT, 'A2A task lineage conflict') END;

  INSERT INTO a2a_task_lineage (
    gateway_key, sender_agent_id, task_id, context_id, mesh_room_id,
    created_at, updated_at
  ) VALUES (
    NEW.gateway_key, NEW.sender_agent_id, NEW.task_id, NEW.context_id,
    NEW.mesh_room_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (gateway_key, sender_agent_id, task_id) DO UPDATE
  SET mesh_room_id = excluded.mesh_room_id,
      updated_at = excluded.updated_at
  WHERE a2a_task_lineage.context_id = excluded.context_id
    AND a2a_task_lineage.mesh_room_id IS NULL;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM a2a_task_lineage AS lineage
    WHERE lineage.gateway_key = NEW.gateway_key
      AND lineage.sender_agent_id = NEW.sender_agent_id
      AND lineage.task_id = NEW.task_id
      AND lineage.context_id = NEW.context_id
      AND lineage.mesh_room_id = NEW.mesh_room_id
  ) THEN RAISE(ABORT, 'A2A task lineage conflict') END;
END;

CREATE TRIGGER IF NOT EXISTS a2a_correlations_lineage_update_guard
BEFORE UPDATE ON a2a_correlations
BEGIN
  SELECT RAISE(ABORT, 'A2A correlation authority is immutable');
END;

COMMIT;
