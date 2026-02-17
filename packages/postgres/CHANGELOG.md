# Changelog

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
