# Changelog

## [0.3.0] - 2026-02-12

### Added

- `scope()` implementation in `SQLiteUnitOfWork` — delegates to `wrap()` internally
  - Provides API compatibility with `@hexaijs/core` `UnitOfWork.scope()`
  - SQLite uses eager transactions (no lazy init), so `scope()` behaves identically to `wrap()`

### Deprecated

- `wrap()` — use `scope()` instead for consistency with other `@hexaijs` packages

Requires `@hexaijs/core` `^0.7.0`.
