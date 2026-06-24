-- New installations create commit-order-safe positions directly.
-- Existing installations that already recorded this migration are upgraded by
-- 02_event_position_counter, because SQL migrations are tracked by directory name.
CREATE TABLE IF NOT EXISTS hexai__event_position_counter (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_position BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT hexai__event_position_counter_singleton CHECK (id = 1)
);

INSERT INTO hexai__event_position_counter (id, last_position)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS hexai__events (
    position BIGINT PRIMARY KEY,
    message_type TEXT NOT NULL,
    headers JSONB NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hexai__events_message_type
    ON hexai__events (message_type);
