CREATE TABLE "hexai__outbox" (
    "position"      bigserial   PRIMARY KEY,
    "event"         jsonb       NOT NULL,
);