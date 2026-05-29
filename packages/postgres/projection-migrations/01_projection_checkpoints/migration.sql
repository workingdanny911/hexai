CREATE TABLE IF NOT EXISTS projection__checkpoints (
    projection_name TEXT PRIMARY KEY,
    last_position BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'rebuilding', 'isolated')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
