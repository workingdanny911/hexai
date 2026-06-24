# Changelog

## [0.6.0] - 2026-06-24

### Added

- Added support for `beforeCommit` drain hooks in `SqliteUnitOfWork`. Drain
  hooks run after ordinary `beforeCommit` hooks and before `COMMIT`.

## [0.5.1] - 2026-03-07

### Changed

- Build tool migrated from tsup to tsgo (`@typescript/native-preview`)
- Module resolution switched to `nodenext` with explicit `.js` import extensions
- Removed path aliases (`@/*`) in favor of relative imports
- ESM-only output (CJS removed)

## [0.5.0] - 2026-02-25

### Breaking Changes

- **Migrated from `sqlite` + `sqlite3` to `better-sqlite3`**
  - `SqliteUnitOfWork` now wraps `better-sqlite3.Database` instead of `sqlite.Database`
  - All async database operations become synchronous (better-sqlite3 is synchronous by design)
  - `getSqliteConnection()` returns `Database` synchronously (no `await` needed)

### Changed

- Peer dependency: `sqlite` + `sqlite3` → `better-sqlite3` `^12.5.0`
- Peer dependency: `@hexaijs/core` `^0.8.0` → `^0.9.0`
- `SqliteRepositoryForTest` uses `db.prepare().all()` / `db.prepare().run()` instead of `db.all()` / `db.run()`

### Migration

```typescript
// Before (sqlite + sqlite3)
import { open } from "sqlite";
import sqlite3 from "sqlite3";
const db = await open({ filename: ":memory:", driver: sqlite3.Database });
await db.run("INSERT INTO ...", [...]);

// After (better-sqlite3)
import Database from "better-sqlite3";
const db = new Database(":memory:");
db.prepare("INSERT INTO ...").run(...);
```

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
