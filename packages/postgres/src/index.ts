export * from "./postgres-unit-of-work.js";
export * from "./run-migrations.js";
export * from "./run-hexai-migrations.js";
export {
    ClientWrapper,
    DatabaseManager,
    TableManager,
    ensureConnection,
} from "./helpers.js";
export * from "./postgres-event-store.js";
export {
    PostgresTransactionalEventStoreSink,
    attachPostgresEventStoreSink,
    TransactionalEventStoreSinkClosedError,
    type PostgresTransactionalEventStoreSinkConfig,
} from "./postgres-transactional-event-store-sink.js";
export * from "./types.js";

// Re-exported from ezcfg/postgres
export { PostgresConfig, PostgresConfigSpec, postgresConfig, type PoolOptions, type FromEnvOptions } from "ezcfg/postgres";
