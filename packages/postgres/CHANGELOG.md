# Changelog

## [0.11.0] - 2026-06-24

### Fixed

- Fixed a projection checkpoint race where PostgreSQL sequence-backed event
  positions could be allocated out of commit order. A later event could commit
  first, be projected, and advance a checkpoint past an earlier event that was
  still uncommitted.

### Changed

- `PostgresEventStore` now allocates event positions from a transaction-scoped
  counter row instead of a PostgreSQL sequence. The counter row lock is held
  until the surrounding transaction commits or rolls back, so a higher event
  position cannot become visible before lower positions are resolved.
- `PostgresEventStore` now inserts explicit event positions and supports
  `positionCounterTableName` for custom event-store tables.
- `PostgresEventStore.fetch()` now reads events and `lastPosition` from one
  database snapshot.

### Migration Notes

- The built-in event-store migration removes the old `position` column default.
  Use a write-stop deployment order: stop old writers, run the migration, then
  start new writers. Old code fails after the migration because it omits
  `position`; new code fails before the migration because the counter table does
  not exist yet. The migration briefly takes an `ACCESS EXCLUSIVE` lock on the
  event table while seeding the counter from existing events.
- Custom event-store tables need a matching singleton position counter table.
  For existing custom tables, seed the counter from `COALESCE(MAX(position), 0)`
  before writing new events with `PostgresEventStore`.

## [0.10.0] - 2026-06-10

### Changed

- Projection processing is now **effectively-once**: the apply + checkpoint transaction reads the committed checkpoint under a row lock (`SELECT ... FOR UPDATE`) and skips events already covered by it, so an in-process retry after a commit-ambiguous failure (server-side commit, client-side error) no longer re-applies committed events. The guard covers live polling, rebuild batch flushes, and the single-event rebuild fallback, and keeps the checkpoint monotonically non-decreasing.
- Read model `apply()` idempotency is now defense-in-depth rather than a hard requirement; `README.md` and `docs/projection.md` document the new delivery semantics and the invariants the guarantee relies on.

### Added

- `CheckpointStore.getForUpdate()` — locked checkpoint read backing the dedup guard.

## [0.9.0] - 2026-05-29

### Added

- Projection engine under `@hexaijs/postgres/projection` for building read models from the `PostgresEventStore` stream:
  - `ProjectionEngine` with live polling, startup/version rebuilds, retry barrier, and isolation.
  - `IPostgresReadModel` plus `SelectorBasedReadModel`, `When`, and `eventTypeMatches` for selector-based read models.
  - `ProjectionWakeQueue` to coalesce "new events" signals into polls.
  - `runProjectionMigrations()` and the `projection__checkpoints` migration.
- New subpath exports: `@hexaijs/postgres/projection` and `@hexaijs/postgres/projection/migrations`.
- Real Postgres integration suite covering apply+checkpoint atomicity, startup rebuild, isolation persistence, version-mismatch rebuild, and ambient-transaction independence.

### Changed

- Read model `canHandle` / `apply` receive the full `StoredEvent` (including the global `position`).
- Projection apply + checkpoint writes run in their own transaction (`Propagation.NEW`) so they never join — and cannot be rolled back by — an ambient caller transaction.

## [0.8.6] - 2026-03-25

### Changed

- `PostgresEventStore.stream()` now prefetches the next batch while yielding current events, hiding DB latency behind processing time
- Guard against unhandled rejection on early stream termination with try/finally

## [0.8.4] - 2026-03-20

### Added

- `PostgresEventStore.stream(afterPosition, batchSize)` — cursor-like batch streaming via repeated queries
- `PostgresEventStore.getEventCount(afterPosition)` — COUNT query for events after a given position

## [0.8.3] - 2026-03-07

### Changed

- Build tool migrated from tsup to tsgo (`@typescript/native-preview`)
- Module resolution switched to `nodenext` with explicit `.js` import extensions
- Removed path aliases (`@/*`) in favor of relative imports
- ESM-only output (CJS removed)

## [0.8.2] - 2026-02-25

### Changed

- Peer dependency: `ezcfg` `^0.1.0` → `^0.3.0`

## [0.8.1] - 2026-02-22

### Added

- Re-export `PostgresConfig` from `ezcfg/postgres` for convenient access
- `envSource` support in PostgresConfig creation

### Changed

- Peer dependency: `@hexaijs/core` `^0.8.0` → `^0.9.0`

## [0.8.0] - 2026-02-15

### Added

- Transaction lifecycle hooks in `DefaultPostgresUnitOfWork` and `PostgresUnitOfWorkForTesting`
  - `beforeCommit(hook)` — runs before COMMIT; failure triggers ROLLBACK instead
  - `afterCommit(hook)` — runs after COMMIT (best-effort)
  - `afterRollback(hook)` — runs after ROLLBACK (best-effort)
  - Hooks are scope-local: registered within `scope()`, cleared after transaction completes
  - NESTED scopes maintain independent hook registries

### Changed

- Peer dependency: `@hexaijs/core` `^0.7.0` → `^0.8.0`

## [0.7.0] - 2026-02-15

### Changed

- Version alignment with `@hexaijs/core` 0.7.0
- No functional changes

## [0.6.0] - 2026-02-12

### Added

- `scope()` implementation in `DefaultPostgresUnitOfWork` — lazy transaction with deferred connection acquisition
  - Connection and `BEGIN` are deferred until the first `withClient()` call inside the scope
  - Supports all propagation options: `NEW`, `EXISTING` (default), `NESTED`
- `scope()` in `PostgresUnitOfWorkForTesting` — savepoint-based, consistent with production behavior

### Deprecated

- `wrap()` — use `scope()` instead for all new code
  - `wrap()` eagerly acquires a connection and issues `BEGIN` immediately
  - `scope()` defers both until first `withClient()`, reducing unnecessary resource consumption

### Migration (v0.5.1 → v0.6.0)

```typescript
// Before (wrap — eager)
await unitOfWork.wrap(async (client) => {
    await client.query("INSERT INTO orders ...", [...]);
});

// After (scope — lazy)
await unitOfWork.scope(async () => {
    await unitOfWork.withClient(async (client) => {
        await client.query("INSERT INTO orders ...", [...]);
    });
});
```

Requires `@hexaijs/core` `^0.7.0`.

## [0.4.0] - 2026-02-04

### Breaking Changes

- **`PostgresUnitOfWork` is now an interface** instead of a class
  - Use `DefaultPostgresUnitOfWork` for the actual implementation
  - Interface: `interface PostgresUnitOfWork extends UnitOfWork<pg.ClientBase, PostgresTransactionOptions> { withClient(...) }`
  - Migration: Replace `new PostgresUnitOfWork(...)` with `new DefaultPostgresUnitOfWork(...)`
- **`query()` method renamed to `withClient()`**
  - Clearer naming: avoids confusion with `client.query()` inside the callback
  - Migration: Replace `.query(async (client) => ...)` with `.withClient(async (client) => ...)`
  - `QueryableUnitOfWork` interface removed from `@hexaijs/core` (now postgres-specific)

### Added

- `createPostgresUnitOfWork` factory function for convenient instantiation
  - `createPostgresUnitOfWork(pool: pg.Pool)` - Pool-based with automatic release
  - `createPostgresUnitOfWork(config: PostgresConfig | string)` - Config/URL-based with automatic cleanup

### Changed

- Client type changed from `pg.Client` to `pg.ClientBase` for better compatibility
  - Now supports both `pg.Client` and `pg.PoolClient`

### Fixed

- Export `types.ts` from package entry point
  - `IsolationLevel`, `ClientFactory`, `ClientCleanUp`, `PostgresTransactionOptions` are now importable from `@hexaijs/postgres`

## [0.3.0] - 2026-02-03

### Added

- `query()` method in `PostgresUnitOfWork` for transaction-free queries
  - Implements `QueryableUnitOfWork` interface from `@hexaijs/core`
  - Context-aware: reuses existing client inside `wrap()`, acquires new connection outside
  - No BEGIN/COMMIT overhead for simple SELECT queries
- `query()` method in `PostgresUnitOfWorkForTesting`
  - Now implements `QueryableUnitOfWork` (previously `UnitOfWork`)
  - Uses test client directly (always within external transaction)

## [0.2.0] - 2025-01-30

### Added

- `PostgresUnitOfWorkForTesting` for transaction-based test isolation
  - Uses savepoints instead of real transactions for test rollback
  - Supports `Propagation.EXISTING` and `Propagation.NESTED`
  - Matches production `abortError` propagation behavior
