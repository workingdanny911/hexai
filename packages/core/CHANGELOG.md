# Changelog

## [0.5.1] - 2026-02-09

### Breaking Changes

- **Message constructor signature changed** from `(payload, headers?)` to `(payload, options?: MessageOptions)`
  - Migration: Replace `new MyMessage(payload, headers)` with `new MyMessage(payload, { headers })`
- **Removed `doSerialize()`** - replaced by public `toJSON()` method
  - Migration: Override `serializePayload()` for custom serialization, or call `toJSON()` directly

### Added

- `MessageOptions` interface: `{ headers?: Record<string, unknown> }`
- `toJSON()` public method: returns `{ headers, payload }` (preserves Date objects)
- `serialize()` public method: returns fully serialized plain object (via `JSON.parse(JSON.stringify(toJSON()))`)
- `serializePayload()` protected hook for custom payload serialization
- `withHeader(field, value)` fluent API for adding headers (returns new instance)

### Changed

- `clone()` now uses `Object.create(Object.getPrototypeOf(this)) + Object.assign` (prototype-preserving)
- `clone()` and `cloneWithHeaders()` moved from `MessageWithAuth` to `Message` base class

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
