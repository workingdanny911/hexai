-- Upgrade path for installations that already ran 01_postgres_event_store
-- when event positions were sequence-backed. This migration is intentionally
-- idempotent so it is safe to rerun if the schema changed before the migration
-- tracking row was recorded.
CREATE TABLE IF NOT EXISTS hexai__event_position_counter (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_position BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT hexai__event_position_counter_singleton CHECK (id = 1)
);

LOCK TABLE hexai__events IN ACCESS EXCLUSIVE MODE;

INSERT INTO hexai__event_position_counter (id, last_position)
SELECT 1, COALESCE(MAX(position), 0)
FROM hexai__events
ON CONFLICT (id) DO UPDATE
SET last_position = GREATEST(
    hexai__event_position_counter.last_position,
    EXCLUDED.last_position
);

ALTER TABLE IF EXISTS hexai__events
    ALTER COLUMN position DROP DEFAULT;

DROP SEQUENCE IF EXISTS hexai__events_position_seq;
