# Changelog

## [0.3.0] - 2026-02-03

### Added

- `QueryableUnitOfWork<Client, Options>` interface extending `UnitOfWork`
  - `query<T>(fn: (client: Client) => Promise<T>): Promise<T>` method for transaction-free queries
  - Context-aware: reuses existing client inside transactions, creates new connection outside
