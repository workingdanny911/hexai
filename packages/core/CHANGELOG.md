# Changelog

## [0.4.0] - 2026-02-04

### Breaking Changes

- **Removed `QueryableUnitOfWork` interface**
  - This interface was only used by `@hexaijs/postgres`
  - Transaction-free queries are now provided directly by `@hexaijs/postgres` via `withClient()` method
  - Migration: No action needed if using `@hexaijs/postgres` - update to postgres 0.4.0

## [0.3.0] - 2026-02-03

### Added

- `QueryableUnitOfWork<Client, Options>` interface extending `UnitOfWork`
  - `query<T>(fn: (client: Client) => Promise<T>): Promise<T>` method for transaction-free queries
  - Context-aware: reuses existing client inside transactions, creates new connection outside
