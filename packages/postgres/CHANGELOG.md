# Changelog

## [0.15.1] - 2026-10-09

### Fixed

- Fixed `DefaultPostgresUnitOfWork` leaking the transaction client when
  `COMMIT` or `ROLLBACK` fails, including rollbacks after a `beforeCommit` hook
  failure and rollbacks on a client that was already closed. Each such failure
  used to leave one pooled client checked out for good; after `max` failures
  every new scope waited for a connection and `pool.end()` never resolved. The
  client is now cleaned up exactly once on every finalization path. The error
  a failed scope rejects with is unchanged: when `ROLLBACK` itself fails after
  a callback or `beforeCommit` failure, the `ROLLBACK` error is still reported
  instead of the error that caused the rollback.
- `createPostgresUnitOfWork(pool)` now destroys a client whose `COMMIT` or
  `ROLLBACK` failed (`release(err)`) instead of returning it to the pool in an
  unknown state. Successfully finalized clients still go back to the pool, and
  connection-string units of work still `end()` the client either way.
- Fixed the client leaking when a transaction fails to start. A root `wrap()`
  whose `BEGIN` or `SET TRANSACTION` failed never released its client; it now
  rolls back (if `BEGIN` had succeeded) and releases the client before
  rejecting with the start failure, as before. If that `ROLLBACK` fails, the
  client is destroyed; a `ROLLBACK` or cleanup failure there is only logged
  with `console.error`. A `scope()` whose callback caught a `BEGIN` failure
  from `withClient()` also kept its client; the client is now destroyed when
  the scope ends. The errors and hooks of a scope whose start failed are
  unchanged, and a client whose `BEGIN` failed is destroyed instead of being
  returned to the pool.
- Fixed finalization racing a transaction start that was still in flight, for
  example when a scope callback fails through `Promise.all()` while a sibling
  `withClient()` is waiting for `BEGIN`. The rollback used to return the
  client to the pool while `BEGIN` (or `SET TRANSACTION`) was still running,
  and the start then sent a late `ROLLBACK` and released the client a second
  time, on a connection another request may already have borrowed, discarding
  that request's work. Finalization now waits for a start that already holds a
  client, so exactly one `ROLLBACK` is sent and the client is released once,
  afterwards. If that `ROLLBACK` fails, the scope settles as in 0.15.0. When
  `BEGIN` had already completed as the rollback began, the scope rejects with
  the `ROLLBACK` error and skips `afterRollback` hooks. Otherwise the scope
  keeps its own outcome (its own error and `afterRollback` hooks, or, for a
  lazy scope, resolving), and the `ROLLBACK` error goes to the `withClient()`
  call that started the transaction, or is logged with `console.error` when
  that call already failed with the start failure. The client is destroyed in
  each case. A callback that returns while `BEGIN` is still running is closed
  without commit hooks, as before; one that returns while `SET TRANSACTION` is
  still running is now rolled back without commit hooks, where 0.15.0 sent
  `COMMIT` during the start. A start still waiting for a pooled client is not
  awaited, so a lazy scope no longer blocks on pool acquisition for work it
  did not await.
- `COMMIT`, `ROLLBACK` and the client cleanup now wait for a `SAVEPOINT`,
  `RELEASE SAVEPOINT` or `ROLLBACK TO SAVEPOINT` statement that is still
  running, so the client is not released while a savepoint statement is in
  flight. A failure of that statement still reaches the nested scope that
  sent it.
- `withClient()` inside a transaction now rejects with
  `TransactionClosedError` instead of running its callback when the
  transaction closed while the call was waiting for the client, for example
  when work the scope did not await resumes after `COMMIT` failed and the
  client was released. 0.15.0 ran the callback on that client.
- Fixed nested `wrap()` calls and `Propagation.NESTED` scopes using a client
  that their transaction had already released. They did not check whether the
  transaction was still open after waiting for its start (or, for a nested
  savepoint, for `SAVEPOINT`), so when the transaction closed meanwhile, or
  when they were entered after the root scope had finished, they still ran
  their callback or sent `SAVEPOINT` and `RELEASE SAVEPOINT` on that client.
  They now reject with `TransactionClosedError` without running the callback.
- Fixed a nested savepoint sending `RELEASE SAVEPOINT` or
  `ROLLBACK TO SAVEPOINT` after its transaction had already ended. When a
  `Propagation.NESTED` callback finished after the root scope rolled back and
  released the client, the savepoint statement reached whatever request had
  borrowed the connection next and could undo that request's own savepoint
  work. The savepoint now sends nothing once its transaction has ended: a
  callback that succeeded rejects with `TransactionClosedError`, and a callback
  that failed rethrows its own error.

### Changed

- A cleanup passed to `new DefaultPostgresUnitOfWork(factory, cleanUp)`
  receives the failure as a second argument when the client is left in an
  unknown state. A cleanup failure still reaches the caller wherever 0.15.0
  already ran the cleanup, and is only logged with `console.error` where the
  cleanup is new (0.15.0 leaked the client there). One narrow case differs:
  when such a custom cleanup throws while a scope is finalized during its own
  transaction start (a sibling failed while `BEGIN` or `SET TRANSACTION` was
  still running), which error the scope reports and whether `afterRollback`
  runs may differ from 0.15.0. The cleanups that `createPostgresUnitOfWork`
  installs do not throw on these paths.

## [0.15.0] - 2026-07-01

### Changed

- SQL-format migrations now run each `migration.sql` and its ledger insert in a
  single transaction. If the process fails before commit, both the schema/data
  change and the ledger row roll back.
- SQL-format migration runners now serialize per namespace-specific migrations
  table with a PostgreSQL advisory lock.
- SQL-format migration ledgers now enforce unique migration names. Existing
  ledgers with duplicate names fail fast instead of being auto-repaired.
- SQL-format `dryRun` no longer creates or updates migration ledger tables,
  indexes, or legacy ledger columns.

### Migration Notes

- SQL migration files must be safe to run inside a PostgreSQL transaction. Do
  not use transaction-control statements or PostgreSQL commands that are
  forbidden in transaction blocks, such as `CREATE INDEX CONCURRENTLY` or
  `VACUUM`.

## [0.14.0] - 2026-06-29

### Added

- Added Postgres-local `PostgresUnitOfWorkObserver` support through
  `onEveryCommit()`. Observers are instance-level, may be registered outside a
  scope, run after root physical commits and transaction-local `afterCommit`
  hooks, and run outside the completed transaction context.
- Added `TransactionResources` as the preferred name for the Postgres-local
  transaction-resource capability. `TransactionResourceAware` remains available
  as a deprecated alias.
- Exported `PostgresTransactionalEventStoreSink` for direct transactional sink
  wiring.
- Added transactional event-store sink `onStored(storedEvents)` support. The
  callback runs after each drain-batch append succeeds and before the surrounding
  transaction commits; throwing or rejecting rolls back that transaction.

### Changed

- `PostgresUnitOfWork` now follows the core capability split: base
  `UnitOfWork` for `scope()`, `UnitOfWorkClientAccess` for `getClient()` and
  deprecated `wrap()`, `TransactionLifecycle` for commit/rollback hooks, and
  the Postgres-local observer capability for `onEveryCommit()`.
- Peer dependency: `@hexaijs/core` `^0.11.0` → `^0.12.0`.

### Fixed

- Fixed transactional event-store sink accept ordering by buffering accepted
  events before awaiting lazy transaction startup.

## [0.13.0] - 2026-06-26

### Added

- Added `attachPostgresEventStoreSink()` for attaching a transactional Postgres
  event-store sink to a subscribable event publisher. Accepted events are
  buffered in a transaction resource and flushed through the bound unit of work's
  transaction client during the `beforeCommit` drain phase. The sink remains a
  Postgres-local implementation detail; the public integration boundary is the
  core `SubscribableEventPublisher<Message>` contract.

### Changed

- Peer dependency: `@hexaijs/core` `^0.10.0` → `^0.11.0`.

## [0.12.0] - 2026-06-24

### Added

- Added support for `beforeCommit` drain hooks in `DefaultPostgresUnitOfWork`.
  Drain hooks run after ordinary `beforeCommit` hooks and before `COMMIT`,
  allowing transaction-local buffers to flush as the final in-transaction
  commit step.
- Added Postgres-local transaction capabilities for commit prevention and
  transaction-local resources: `CommitControl`, `TransactionResourceAware`,
  `createTransactionResourceKey()`, `TransactionAbortedError`, and
  `UnsupportedNestedTransactionCapabilityError`.
- Added `TransactionClosedError` for attempts to use a finalized transaction
  client from a leaked async context.

### Changed

- `DefaultPostgresUnitOfWork` and `PostgresUnitOfWorkForTesting` now run
  `afterCommit` and `afterRollback` hooks outside the completed transaction
  context. Use `withClient()` for follow-up database work in after hooks;
  `getClient()` no longer exposes the finalized transaction client there.
- `DefaultPostgresUnitOfWork` now rolls back instead of committing when
  `preventCommit()` is called, while preserving the callback's return value.
  This supports value-based error contracts such as returning an error result.
- `DefaultPostgresUnitOfWork` now rejects root finalization with
  `TransactionAbortedError` when an `EXISTING` nested scope fails and the root
  callback returns normally without acknowledging the aborted transaction through
  `preventCommit()`.
- Commit-control and transaction-resource capabilities now fail fast inside
  `Propagation.NESTED` savepoints. Use the root transaction scope or
  `Propagation.NEW` when a capability needs its own transaction boundary.

### Fixed

- Fixed a transaction-context leak where Postgres `afterCommit` or
  `afterRollback` hooks could reuse a released transaction client when they
  called `withClient()` on the same unit of work.
- Fixed lazy no-op transaction scopes so leaked async work cannot open a new
  transaction after the scope has already completed.

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
