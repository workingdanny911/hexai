# Changelog

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
