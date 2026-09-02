-- Repeatable migration marker only. The exported
-- initializeA2ACorrelationSchema() runtime initializer is the sole idempotent
-- authority for reconciling the original 0002 schema. SQLite does not support
-- a safe static ADD COLUMN IF NOT EXISTS, so this file must never blindly ALTER.
-- Legacy rows retain NULL sequence authority and fail closed when read; the
-- runtime-installed insert guard requires sequence authority for every new row.
SELECT 1 WHERE 0;
