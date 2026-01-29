# Changelog

## [0.2.0] - 2025-01-30

### Added

- `PostgresUnitOfWorkForTesting` for transaction-based test isolation
  - Uses savepoints instead of real transactions for test rollback
  - Supports `Propagation.EXISTING` and `Propagation.NESTED`
  - Matches production `abortError` propagation behavior
