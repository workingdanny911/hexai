CREATE TABLE IF NOT EXISTS hexai__events (
    position BIGSERIAL PRIMARY KEY,
    message_type TEXT NOT NULL,
    headers JSONB NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hexai__events_message_type
    ON hexai__events (message_type);
