# Changelog

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
