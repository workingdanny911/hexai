CREATE TABLE "hexai__outbox"
(
    "position"   serial PRIMARY KEY,
    "message"    jsonb       NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "hexai__locks"
(
    "id"          serial PRIMARY KEY,
    "name"        varchar(255) UNIQUE NOT NULL,
    "acquired_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "hexai__idempotency_support"
(
    "key"          varchar(255) NOT NULL,
    "message_id"   uuid         NOT NULL,
    "processed_at" timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "hexai__idempotency_support_key_idx" ON "hexai__idempotency_support" ("key", "message_id");