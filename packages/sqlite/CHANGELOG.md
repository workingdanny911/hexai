# Changelog

## [0.4.0] - 2026-02-15

### Added

- Transaction lifecycle hooks in `SqliteUnitOfWork`
  - `beforeCommit(hook)` — runs before COMMIT; failure triggers ROLLBACK instead
  - `afterCommit(hook)` — runs after COMMIT (best-effort)
  - `afterRollback(hook)` — runs after ROLLBACK (best-effort)
  - Hooks are scope-local: registered within root transaction scope, cleared after completion
  - Delegates to `TransactionHooks` from `@hexaijs/core`

### Changed

- Peer dependency: `@hexaijs/core` `^0.7.0` → `^0.8.0`

## [0.3.0] - 2026-02-12

### Added

- `scope()` implementation in `SqliteUnitOfWork` — delegates to `wrap()` internally
  - Provides API compatibility with `@hexaijs/core` `UnitOfWork.scope()`
  - SQLite uses eager transactions (no lazy init), so `scope()` behaves identically to `wrap()`

### Deprecated

- `wrap()` — use `scope()` instead for consistency with other `@hexaijs` packages

Requires `@hexaijs/core` `^0.7.0`.
